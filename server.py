#!/usr/bin/env python3
"""PageWatch local server: website monitoring, SQLite storage and JSON API."""

from __future__ import annotations

import argparse
import difflib
import hashlib
from html.parser import HTMLParser
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import smtplib
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from email.message import EmailMessage
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import Request, urlopen
import webbrowser


APP_DIR = Path(__file__).resolve().parent
DIST_DIR = APP_DIR / "dist"
DATA_DIR = APP_DIR / "data"
DB_PATH = DATA_DIR / "pagewatch.db"
SETTINGS_PATH = DATA_DIR / "settings.json"
LOG_PATH = DATA_DIR / "pagewatch.log"
HOST = "127.0.0.1"
PORT = 8765
DEFAULT_ALLOWED_ORIGINS = {"https://t-shiokawa1.github.io"}
USER_AGENT = "PageWatch/1.0 (local personal website monitor)"
MAX_PAGE_BYTES = 10 * 1024 * 1024
CHECK_LOCK = threading.Lock()
STOP_EVENT = threading.Event()


DEFAULT_SETTINGS: Dict[str, Any] = {
    "desktop_notifications": True,
    "email_enabled": False,
    "email_to": "",
    "smtp_host": "",
    "smtp_port": 587,
    "smtp_user": "",
    "smtp_password": "",
    "smtp_from": "",
    "smtp_ssl": False,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def db_connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA foreign_keys=ON")
    return connection


def init_database() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db_connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS sites (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                url TEXT NOT NULL UNIQUE,
                interval_minutes INTEGER NOT NULL DEFAULT 15,
                enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'waiting',
                last_checked TEXT,
                last_changed TEXT,
                last_error TEXT,
                etag TEXT,
                last_modified TEXT,
                content_hash TEXT,
                snapshot TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                site_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                summary TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS events_site_created
                ON events(site_id, created_at DESC);
            """
        )
        count = db.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
        if count == 0:
            db.execute(
                """
                INSERT INTO sites (name, url, interval_minutes, enabled, status, created_at)
                VALUES (?, ?, ?, 1, 'waiting', ?)
                """,
                (
                    "Fukazawa Group",
                    "https://fukazawa.icems.kyoto-u.ac.jp/",
                    15,
                    now_iso(),
                ),
            )


def load_settings() -> Dict[str, Any]:
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_PATH.exists():
        try:
            loaded = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                settings.update({key: value for key, value in loaded.items() if key in settings})
        except (OSError, json.JSONDecodeError):
            logging.exception("Could not read settings")
    return settings


def save_settings(incoming: Dict[str, Any]) -> Dict[str, Any]:
    current = load_settings()
    allowed = set(DEFAULT_SETTINGS)
    for key, value in incoming.items():
        if key not in allowed:
            continue
        if key == "smtp_password" and value == "":
            continue
        current[key] = value
    current["smtp_port"] = max(1, min(65535, int(current.get("smtp_port", 587))))
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = SETTINGS_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, SETTINGS_PATH)
    return public_settings(current)


def public_settings(settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    result = dict(settings or load_settings())
    result["smtp_password_set"] = bool(result.get("smtp_password"))
    result["smtp_password"] = ""
    return result


class VisibleContentParser(HTMLParser):
    """Extract text and image references that represent visible page content."""

    ignored_tags = {
        "script",
        "style",
        "noscript",
        "template",
        "svg",
        "canvas",
        "iframe",
        "object",
        "embed",
        "head",
    }
    void_tags = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
    block_tags = {
        "article",
        "aside",
        "blockquote",
        "br",
        "dd",
        "div",
        "dl",
        "dt",
        "figcaption",
        "figure",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "li",
        "main",
        "nav",
        "p",
        "section",
        "table",
        "td",
        "th",
        "tr",
        "ul",
        "ol",
    }

    def __init__(self, base_url: str) -> None:
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.skip_depth = 0
        self.parts: List[str] = []
        self.images: List[str] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        attributes = {key.lower(): (value or "") for key, value in attrs}
        hidden = (
            "hidden" in attributes
            or attributes.get("aria-hidden", "").lower() == "true"
            or "display:none" in attributes.get("style", "").replace(" ", "").lower()
            or "visibility:hidden" in attributes.get("style", "").replace(" ", "").lower()
        )
        if self.skip_depth or tag in self.ignored_tags or hidden:
            if tag not in self.void_tags:
                self.skip_depth += 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")
        if tag == "img":
            src = attributes.get("src") or attributes.get("data-src") or ""
            alt = re.sub(r"\s+", " ", attributes.get("alt", "")).strip()
            if src:
                parsed = urlparse(urljoin(self.base_url, src))
                stable_url = parsed._replace(query="", fragment="").geturl()
                self.images.append(f"[画像] {alt} {stable_url}".strip())

    def handle_startendtag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        self.handle_starttag(tag, attrs)
        if self.skip_depth:
            self.skip_depth -= 1

    def handle_endtag(self, tag: str) -> None:
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.block_tags:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.parts.append(data)

    def normalized(self) -> str:
        raw = "".join(self.parts)
        lines = []
        for line in raw.splitlines():
            clean = re.sub(r"\s+", " ", line).strip()
            if clean:
                lines.append(clean)
        lines.extend(sorted(set(self.images)))
        return "\n".join(lines)


def normalize_html(html_text: str, base_url: str) -> str:
    parser = VisibleContentParser(base_url)
    parser.feed(html_text)
    parser.close()
    return parser.normalized()


def decode_page(raw: bytes, content_type: str) -> str:
    match = re.search(r"charset=([\w-]+)", content_type, flags=re.IGNORECASE)
    candidates = [match.group(1)] if match else []
    candidates.extend(["utf-8", "shift_jis", "euc_jp"])
    for encoding in candidates:
        try:
            return raw.decode(encoding)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def fetch_site(site: sqlite3.Row) -> Tuple[str, Dict[str, str]]:
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
    }
    if site["etag"]:
        headers["If-None-Match"] = site["etag"]
    if site["last_modified"]:
        headers["If-Modified-Since"] = site["last_modified"]
    request = Request(site["url"], headers=headers)
    try:
        with urlopen(request, timeout=30) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/html" not in content_type and "application/xhtml+xml" not in content_type:
                raise RuntimeError(f"HTMLページではありません: {content_type or 'Content-Type不明'}")
            raw = response.read(MAX_PAGE_BYTES + 1)
            if len(raw) > MAX_PAGE_BYTES:
                raise RuntimeError("ページサイズが10MBを超えています")
            return decode_page(raw, content_type), {
                "etag": response.headers.get("ETag", ""),
                "last_modified": response.headers.get("Last-Modified", ""),
            }
    except HTTPError as exc:
        if exc.code == HTTPStatus.NOT_MODIFIED:
            return "", {"not_modified": "1"}
        raise RuntimeError(f"HTTP {exc.code}") from exc
    except URLError as exc:
        raise RuntimeError(str(exc.reason)) from exc


def diff_summary(old: str, new: str) -> str:
    added: List[str] = []
    removed: List[str] = []
    for line in difflib.ndiff(old.splitlines(), new.splitlines()):
        value = line[2:].strip()
        if not value or line.startswith("? "):
            continue
        if line.startswith("+ ") and len(added) < 4:
            added.append(value[:180])
        elif line.startswith("- ") and len(removed) < 4:
            removed.append(value[:180])
    pieces = []
    if added:
        pieces.append("追加: " + " / ".join(added))
    if removed:
        pieces.append("削除: " + " / ".join(removed))
    return "\n".join(pieces) or "表示内容が変更されました"


def add_event(db: sqlite3.Connection, site_id: int, kind: str, summary: str) -> None:
    db.execute(
        "INSERT INTO events (site_id, kind, summary, created_at) VALUES (?, ?, ?, ?)",
        (site_id, kind, summary, now_iso()),
    )


def send_desktop_notification(title: str, message: str) -> None:
    if sys.platform != "darwin":
        return
    script = (
        "on run argv\n"
        "display notification (item 2 of argv) with title (item 1 of argv)\n"
        "end run"
    )
    subprocess.run(
        ["osascript", "-e", script, title, message[:240]],
        check=False,
        capture_output=True,
        text=True,
    )


def send_email(settings: Dict[str, Any], subject: str, body: str) -> None:
    host = str(settings.get("smtp_host", "")).strip()
    recipient = str(settings.get("email_to", "")).strip()
    username = str(settings.get("smtp_user", "")).strip()
    sender = str(settings.get("smtp_from", "")).strip() or username
    password = str(settings.get("smtp_password", ""))
    if not host or not recipient or not sender:
        raise RuntimeError("メール設定が不足しています")

    mail = EmailMessage()
    mail["Subject"] = subject
    mail["From"] = sender
    mail["To"] = recipient
    mail.set_content(body)
    port = int(settings.get("smtp_port", 587))
    use_ssl = bool(settings.get("smtp_ssl", False))
    context = ssl.create_default_context()
    if use_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, timeout=30, context=context)
    else:
        server = smtplib.SMTP(host, port, timeout=30)
    try:
        if not use_ssl:
            server.starttls(context=context)
        if username:
            server.login(username, password)
        server.send_message(mail)
    finally:
        server.quit()


def notify_change(site: sqlite3.Row, summary: str) -> None:
    settings = load_settings()
    subject = f"[PageWatch] {site['name']} が更新されました"
    body = f"{site['name']}\n{site['url']}\n\n{summary}\n"
    if settings.get("desktop_notifications", True):
        send_desktop_notification(subject, summary)
    if settings.get("email_enabled", False):
        send_email(settings, subject, body)


def check_site(site_id: int) -> Dict[str, Any]:
    if not CHECK_LOCK.acquire(blocking=False):
        raise RuntimeError("別の確認処理が実行中です")
    try:
        with db_connect() as db:
            site = db.execute("SELECT * FROM sites WHERE id = ?", (site_id,)).fetchone()
            if site is None:
                raise KeyError("監視サイトが見つかりません")
            db.execute("UPDATE sites SET status = 'checking', last_error = NULL WHERE id = ?", (site_id,))

        try:
            html_text, headers = fetch_site(site)
            checked_at = now_iso()
            with db_connect() as db:
                if headers.get("not_modified"):
                    db.execute(
                        "UPDATE sites SET status = 'unchanged', last_checked = ?, last_error = NULL WHERE id = ?",
                        (checked_at, site_id),
                    )
                    return {"changed": False, "status": "unchanged"}

                snapshot = normalize_html(html_text, site["url"])
                if not snapshot:
                    raise RuntimeError("比較できる表示内容が見つかりません")
                content_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
                previous_hash = site["content_hash"]
                common_values = (
                    checked_at,
                    headers.get("etag", ""),
                    headers.get("last_modified", ""),
                    content_hash,
                    snapshot,
                    site_id,
                )
                if previous_hash is None:
                    db.execute(
                        """
                        UPDATE sites SET status = 'baseline', last_checked = ?, last_error = NULL,
                            etag = ?, last_modified = ?, content_hash = ?, snapshot = ?
                        WHERE id = ?
                        """,
                        common_values,
                    )
                    add_event(db, site_id, "baseline", "初回の比較基準を保存しました")
                    return {"changed": False, "status": "baseline"}

                if previous_hash == content_hash:
                    db.execute(
                        """
                        UPDATE sites SET status = 'unchanged', last_checked = ?, last_error = NULL,
                            etag = ?, last_modified = ?, content_hash = ?, snapshot = ?
                        WHERE id = ?
                        """,
                        common_values,
                    )
                    return {"changed": False, "status": "unchanged"}

                summary = diff_summary(site["snapshot"] or "", snapshot)
                db.execute(
                    """
                    UPDATE sites SET status = 'changed', last_checked = ?, last_changed = ?,
                        last_error = NULL, etag = ?, last_modified = ?, content_hash = ?, snapshot = ?
                    WHERE id = ?
                    """,
                    (
                        checked_at,
                        checked_at,
                        headers.get("etag", ""),
                        headers.get("last_modified", ""),
                        content_hash,
                        snapshot,
                        site_id,
                    ),
                )
                add_event(db, site_id, "changed", summary)

            try:
                notify_change(site, summary)
            except Exception as exc:  # Notification failure must not undo monitoring state.
                logging.exception("Notification failed")
                with db_connect() as db:
                    add_event(db, site_id, "notification_error", f"通知に失敗しました: {exc}")
            return {"changed": True, "status": "changed", "summary": summary}
        except Exception as exc:
            logging.exception("Check failed for site %s", site_id)
            with db_connect() as db:
                db.execute(
                    "UPDATE sites SET status = 'error', last_checked = ?, last_error = ? WHERE id = ?",
                    (now_iso(), str(exc)[:500], site_id),
                )
                add_event(db, site_id, "error", f"確認に失敗しました: {str(exc)[:500]}")
            raise RuntimeError(str(exc)) from exc
    finally:
        CHECK_LOCK.release()


def check_all_enabled() -> None:
    with db_connect() as db:
        ids = [row[0] for row in db.execute("SELECT id FROM sites WHERE enabled = 1 ORDER BY id")]
    for site_id in ids:
        if STOP_EVENT.is_set():
            return
        try:
            check_site(site_id)
        except RuntimeError:
            continue


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def scheduler_loop() -> None:
    time.sleep(2)
    while not STOP_EVENT.is_set():
        now = datetime.now(timezone.utc)
        with db_connect() as db:
            sites = db.execute("SELECT id, interval_minutes, last_checked FROM sites WHERE enabled = 1").fetchall()
        for site in sites:
            last_checked = parse_iso(site["last_checked"])
            due = last_checked is None or (now - last_checked).total_seconds() >= site["interval_minutes"] * 60
            if due:
                try:
                    check_site(site["id"])
                except RuntimeError:
                    pass
        STOP_EVENT.wait(30)


def site_rows() -> List[Dict[str, Any]]:
    with db_connect() as db:
        rows = db.execute(
            """
            SELECT id, name, url, interval_minutes, enabled, status, last_checked,
                   last_changed, last_error, created_at
            FROM sites ORDER BY enabled DESC, created_at DESC
            """
        ).fetchall()
    return [dict(row) for row in rows]


def event_rows(limit: int = 50) -> List[Dict[str, Any]]:
    limit = max(1, min(200, limit))
    with db_connect() as db:
        rows = db.execute(
            """
            SELECT events.id, events.site_id, events.kind, events.summary, events.created_at,
                   sites.name AS site_name, sites.url AS site_url
            FROM events JOIN sites ON sites.id = events.site_id
            ORDER BY events.created_at DESC, events.id DESC LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def app_state() -> Dict[str, Any]:
    sites = site_rows()
    summary = {
        "total": len(sites),
        "active": sum(1 for site in sites if site["enabled"]),
        "changed": sum(1 for site in sites if site["status"] == "changed"),
        "errors": sum(1 for site in sites if site["status"] == "error"),
    }
    return {
        "summary": summary,
        "sites": sites,
        "events": event_rows(),
        "settings": public_settings(),
    }


class PageWatchHandler(BaseHTTPRequestHandler):
    server_version = "PageWatch/1.0"

    def log_message(self, format_string: str, *args: Any) -> None:
        logging.info("%s - %s", self.address_string(), format_string % args)

    def allowed_origin(self) -> Optional[str]:
        origin = self.headers.get("Origin")
        allowed = getattr(self.server, "allowed_origins", DEFAULT_ALLOWED_ORIGINS)
        return origin if origin in allowed else None

    def cors_headers(self) -> Dict[str, str]:
        origin = self.allowed_origin()
        if not origin:
            return {}
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Allow-Private-Network": "true",
            "Vary": "Origin",
        }

    def end_headers(self) -> None:
        for name, value in self.cors_headers().items():
            self.send_header(name, value)
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        if not self.allowed_origin():
            self.send_json({"error": "この公開元からの接続は許可されていません"}, 403)
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> Dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Lengthが不正です") from exc
        if length > 1024 * 1024:
            raise ValueError("リクエストが大きすぎます")
        if length == 0:
            return {}
        data = json.loads(self.rfile.read(length).decode("utf-8"))
        if not isinstance(data, dict):
            raise ValueError("JSONオブジェクトが必要です")
        return data

    def route_site_id(self) -> Optional[int]:
        match = re.fullmatch(r"/api/sites/(\d+)(?:/check)?", urlparse(self.path).path)
        return int(match.group(1)) if match else None

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({"ok": True, "time": now_iso()})
            return
        if path == "/api/state":
            self.send_json(app_state())
            return
        if path == "/api/events":
            self.send_json({"events": event_rows()})
            return
        self.serve_static(path)

    def do_POST(self) -> None:  # noqa: N802
        try:
            path = urlparse(self.path).path
            data = self.read_json()
            if path == "/api/sites":
                url = str(data.get("url", "")).strip()
                parsed = urlparse(url)
                if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                    raise ValueError("http:// または https:// から始まるURLを入力してください")
                name = str(data.get("name", "")).strip() or parsed.netloc
                interval = max(5, min(1440, int(data.get("interval_minutes", 15))))
                try:
                    with db_connect() as db:
                        cursor = db.execute(
                            """
                            INSERT INTO sites (name, url, interval_minutes, enabled, status, created_at)
                            VALUES (?, ?, ?, 1, 'waiting', ?)
                            """,
                            (name[:120], url, interval, now_iso()),
                        )
                        site_id = cursor.lastrowid
                except sqlite3.IntegrityError as exc:
                    raise ValueError("このURLはすでに登録されています") from exc
                threading.Thread(target=self.safe_check, args=(site_id,), daemon=True).start()
                self.send_json({"ok": True, "id": site_id}, 201)
                return
            if path == "/api/check-all":
                threading.Thread(target=check_all_enabled, daemon=True).start()
                self.send_json({"ok": True}, 202)
                return
            if path == "/api/settings/test-email":
                settings = load_settings()
                send_email(
                    settings,
                    "[PageWatch] テストメール",
                    "PageWatchからのテストメールです。メール通知は正常に設定されています。\n",
                )
                self.send_json({"ok": True})
                return
            if path.endswith("/check"):
                site_id = self.route_site_id()
                if site_id is None:
                    raise KeyError("監視サイトが見つかりません")
                result = check_site(site_id)
                self.send_json({"ok": True, **result})
                return
            self.send_json({"error": "Not found"}, 404)
        except KeyError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, RuntimeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)
        except Exception as exc:
            logging.exception("POST failed")
            self.send_json({"error": str(exc)}, 500)

    def safe_check(self, site_id: int) -> None:
        time.sleep(0.2)
        try:
            check_site(site_id)
        except RuntimeError:
            pass

    def do_PATCH(self) -> None:  # noqa: N802
        try:
            site_id = self.route_site_id()
            if site_id is None:
                raise KeyError("監視サイトが見つかりません")
            data = self.read_json()
            updates = []
            values: List[Any] = []
            if "enabled" in data:
                updates.append("enabled = ?")
                values.append(1 if data["enabled"] else 0)
                updates.append("status = CASE WHEN ? = 1 THEN 'waiting' ELSE 'paused' END")
                values.append(1 if data["enabled"] else 0)
            if "name" in data:
                updates.append("name = ?")
                values.append(str(data["name"]).strip()[:120])
            if "interval_minutes" in data:
                updates.append("interval_minutes = ?")
                values.append(max(5, min(1440, int(data["interval_minutes"]))))
            if not updates:
                raise ValueError("変更項目がありません")
            values.append(site_id)
            with db_connect() as db:
                cursor = db.execute(f"UPDATE sites SET {', '.join(updates)} WHERE id = ?", values)
                if cursor.rowcount == 0:
                    raise KeyError("監視サイトが見つかりません")
            self.send_json({"ok": True})
        except KeyError as exc:
            self.send_json({"error": str(exc)}, 404)
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_PUT(self) -> None:  # noqa: N802
        try:
            if urlparse(self.path).path != "/api/settings":
                self.send_json({"error": "Not found"}, 404)
                return
            settings = save_settings(self.read_json())
            self.send_json({"ok": True, "settings": settings})
        except (ValueError, json.JSONDecodeError, OSError) as exc:
            self.send_json({"error": str(exc)}, 400)

    def do_DELETE(self) -> None:  # noqa: N802
        site_id = self.route_site_id()
        if site_id is None:
            self.send_json({"error": "Not found"}, 404)
            return
        with db_connect() as db:
            cursor = db.execute("DELETE FROM sites WHERE id = ?", (site_id,))
        if cursor.rowcount == 0:
            self.send_json({"error": "監視サイトが見つかりません"}, 404)
            return
        self.send_json({"ok": True})

    def serve_static(self, request_path: str) -> None:
        if not DIST_DIR.exists():
            self.send_json({"error": "画面が未ビルドです。npm run build を実行してください。"}, 503)
            return
        relative = unquote(request_path).lstrip("/") or "index.html"
        target = (DIST_DIR / relative).resolve()
        dist_root = DIST_DIR.resolve()
        if not str(target).startswith(str(dist_root)) or not target.is_file():
            target = dist_root / "index.html"
        try:
            body = target.read_bytes()
        except OSError:
            self.send_error(404)
            return
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def configure_logging() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[logging.FileHandler(LOG_PATH, encoding="utf-8"), logging.StreamHandler()],
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="PageWatch local website monitor")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="起動後にブラウザを開く")
    parser.add_argument("--open-url", help="--openで開く管理画面URL")
    parser.add_argument(
        "--allow-origin",
        action="append",
        dest="allowed_origins",
        help="ローカルAPIへの接続を許可するHTTPS origin（複数指定可）",
    )
    args = parser.parse_args()

    configure_logging()
    init_database()
    scheduler = threading.Thread(target=scheduler_loop, name="pagewatch-scheduler", daemon=True)
    scheduler.start()

    server = ThreadingHTTPServer((args.host, args.port), PageWatchHandler)
    server.allowed_origins = set(args.allowed_origins or DEFAULT_ALLOWED_ORIGINS)  # type: ignore[attr-defined]
    url = f"http://{args.host}:{args.port}"
    logging.info("PageWatch started at %s", url)
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(args.open_url or url)).start()
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        STOP_EVENT.set()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
