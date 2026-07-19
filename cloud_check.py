#!/usr/bin/env python3
"""PageWatch cloud checker: runs inside GitHub Actions on the private data repo.

Reads sites.json / state.json from the data repo (current directory), checks
sites that are due, and writes the updated state.json back. Change detection
reuses the exact same logic as the local server (server.py) so both modes
behave identically. Email notification uses SMTP_* environment variables
provided as Actions secrets; desktop notification is not available here.

Usage:
    python cloud_check.py [--data DIR] [--only SITE_ID] [--all]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# server.py lives next to this file (the app repo checkout).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402

MIN_INTERVAL = 30
DEFAULT_INTERVAL = 60
MAX_EVENTS = 100


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def load_json(path: Path, fallback: Any) -> Any:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return fallback


def email_settings() -> Dict[str, Any]:
    return {
        "email_enabled": bool(os.environ.get("SMTP_HOST") and os.environ.get("EMAIL_TO")),
        "email_to": os.environ.get("EMAIL_TO", ""),
        "smtp_host": os.environ.get("SMTP_HOST", ""),
        "smtp_port": int(os.environ.get("SMTP_PORT", "587") or 587),
        "smtp_user": os.environ.get("SMTP_USER", ""),
        "smtp_password": os.environ.get("SMTP_PASSWORD", ""),
        "smtp_from": os.environ.get("SMTP_FROM", ""),
        "smtp_ssl": os.environ.get("SMTP_SSL", "") == "1",
    }


def is_due(site: Dict[str, Any], entry: Dict[str, Any]) -> bool:
    if not site.get("enabled", True):
        return False
    last = parse_iso(entry.get("last_checked"))
    if last is None:
        return True
    interval = max(MIN_INTERVAL, int(site.get("interval_minutes") or DEFAULT_INTERVAL))
    return (datetime.now(timezone.utc) - last).total_seconds() >= interval * 60 - 90


def add_event(state: Dict[str, Any], site: Dict[str, Any], kind: str, summary: str) -> None:
    events: List[Dict[str, Any]] = state.setdefault("events", [])
    next_id = 1 + max((e.get("id", 0) for e in events), default=0)
    events.insert(0, {
        "id": next_id,
        "site_id": site["id"],
        "site_name": site.get("name") or site["url"],
        "kind": kind,
        "summary": summary,
        "created_at": now_iso(),
    })
    del events[MAX_EVENTS:]


def check_one(site: Dict[str, Any], entry: Dict[str, Any], state: Dict[str, Any], mail: Dict[str, Any]) -> str:
    checked_at = now_iso()
    fetch_input = {
        "url": site["url"],
        "etag": entry.get("etag", ""),
        "last_modified": entry.get("last_modified", ""),
    }
    try:
        html_text, headers = server.fetch_site(fetch_input)
    except Exception as exc:
        entry.update(status="error", last_checked=checked_at, last_error=str(exc)[:500])
        add_event(state, site, "error", f"確認に失敗しました: {str(exc)[:500]}")
        return "error"

    if headers.get("not_modified"):
        entry.update(status="unchanged", last_checked=checked_at, last_error=None)
        return "unchanged"

    try:
        snapshot = server.normalize_content(
            html_text, headers.get("content_type", "text/html"), site["url"]
        )
    except RuntimeError as exc:
        entry.update(status="error", last_checked=checked_at, last_error=str(exc)[:500])
        add_event(state, site, "error", f"確認に失敗しました: {str(exc)[:500]}")
        return "error"
    if not snapshot:
        entry.update(status="error", last_checked=checked_at, last_error="比較できる表示内容が見つかりません")
        add_event(state, site, "error", "確認に失敗しました: 比較できる表示内容が見つかりません")
        return "error"

    content_hash = hashlib.sha256(snapshot.encode("utf-8")).hexdigest()
    previous_hash = entry.get("content_hash")
    common = dict(
        last_checked=checked_at,
        last_error=None,
        etag=headers.get("etag", ""),
        last_modified=headers.get("last_modified", ""),
        content_hash=content_hash,
        snapshot=snapshot,
    )

    if previous_hash is None:
        entry.update(status="baseline", **common)
        add_event(state, site, "baseline", "初回の比較基準を保存しました")
        return "baseline"

    if previous_hash == content_hash:
        entry.update(status="unchanged", **common)
        return "unchanged"

    added, removed = server.content_change(entry.get("snapshot") or "", snapshot)
    if not added and not removed:
        # Reorder-only: absorb silently, exactly like the local server.
        entry.update(status="unchanged", **common)
        return "unchanged"

    summary = server.summarize_changes(added, removed)
    entry.update(status="changed", last_changed=checked_at, **common)
    add_event(state, site, "changed", summary)

    if mail["email_enabled"]:
        try:
            server.send_email(
                mail,
                f"PageWatch更新: {site.get('name') or site['url']}",
                f"{site.get('name') or site['url']} が更新されました。\n{site['url']}\n\n{summary}",
            )
        except Exception as exc:
            add_event(state, site, "notification_error", f"通知に失敗しました: {exc}")
    return "changed"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", default=".", help="data repo directory (sites.json / state.json)")
    parser.add_argument("--only", default="", help="check only this site id")
    parser.add_argument("--all", action="store_true", help="check every enabled site now")
    args = parser.parse_args()

    data_dir = Path(args.data).resolve()
    sites: List[Dict[str, Any]] = load_json(data_dir / "sites.json", [])
    state: Dict[str, Any] = load_json(data_dir / "state.json", {})
    state.setdefault("sites", {})
    state.setdefault("events", [])

    # Drop state for sites that were deleted from the list.
    known = {str(s["id"]) for s in sites}
    state["sites"] = {k: v for k, v in state["sites"].items() if k in known}

    mail = email_settings()
    results = []
    for site in sites:
        key = str(site["id"])
        entry = state["sites"].setdefault(key, {})
        if args.only and key != str(args.only):
            continue
        if not args.only and not args.all and not is_due(site, entry):
            continue
        if not site.get("enabled", True) and not args.only:
            continue
        results.append((site.get("name") or site["url"], check_one(site, entry, state, mail)))

    state["last_run"] = now_iso()
    (data_dir / "state.json").write_text(
        json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    for name, outcome in results:
        print(f"{outcome}: {name}")
    print(f"checked {len(results)} site(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
