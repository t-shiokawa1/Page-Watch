import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

type Site = {
  id: number;
  name: string;
  url: string;
  interval_minutes: number;
  enabled: number;
  status: string;
  last_checked: string | null;
  last_changed: string | null;
  last_error: string | null;
  created_at: string;
};

type EventItem = {
  id: number;
  site_id: number;
  site_name: string;
  site_url: string;
  kind: string;
  summary: string;
  created_at: string;
};

type Settings = {
  desktop_notifications: boolean;
  email_enabled: boolean;
  email_to: string;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password: string;
  smtp_password_set: boolean;
  smtp_from: string;
  smtp_ssl: boolean;
};

type AppState = {
  summary: { total: number; active: number; changed: number; errors: number };
  sites: Site[];
  events: EventItem[];
  settings: Settings;
};

const emptyState: AppState = {
  summary: { total: 0, active: 0, changed: 0, errors: 0 },
  sites: [],
  events: [],
  settings: {
    desktop_notifications: true,
    email_enabled: false,
    email_to: "",
    smtp_host: "",
    smtp_port: 587,
    smtp_user: "",
    smtp_password: "",
    smtp_password_set: false,
    smtp_from: "",
    smtp_ssl: false,
  },
};

const statusLabels: Record<string, { label: string; tone: string }> = {
  waiting: { label: "確認待ち", tone: "neutral" },
  checking: { label: "確認中", tone: "working" },
  baseline: { label: "監視中", tone: "good" },
  unchanged: { label: "変化なし", tone: "good" },
  changed: { label: "更新あり", tone: "changed" },
  error: { label: "要確認", tone: "error" },
  paused: { label: "一時停止", tone: "neutral" },
};

const apiBase = (import.meta.env.VITE_API_BASE || "").replace(/\/$/, "");

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
    });
  } catch {
    throw new Error(
      apiBase
        ? "このMacの監視エンジンに接続できません。start.commandを起動してください。"
        : "監視エンジンに接続できません。",
    );
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "処理に失敗しました");
  return data as T;
}

function formatDate(value: string | null): string {
  if (!value) return "まだ確認していません";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function StatusBadge({ status }: { status: string }) {
  const value = statusLabels[status] || statusLabels.waiting;
  return (
    <span className={`status-badge status-${value.tone}`}>
      <span className="status-dot" />
      {value.label}
    </span>
  );
}

function App() {
  const [state, setState] = useState<AppState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [interval, setIntervalValue] = useState(15);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>(emptyState.settings);

  const loadState = useCallback(async (quiet = false) => {
    try {
      const next = await api<AppState>("/api/state");
      setState(next);
      setSettings((current) =>
        settingsDialog.current?.open ? current : { ...next.settings, smtp_password: "" },
      );
    } catch (error) {
      if (!quiet) setMessage(error instanceof Error ? error.message : "接続できません");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadState();
    const timer = window.setInterval(() => loadState(true), 5000);
    return () => window.clearInterval(timer);
  }, [loadState]);

  const showMessage = (value: string) => {
    setMessage(value);
    window.setTimeout(() => setMessage(null), 3500);
  };

  const addSite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("add");
    try {
      await api("/api/sites", {
        method: "POST",
        body: JSON.stringify({ name, url, interval_minutes: interval }),
      });
      setName("");
      setUrl("");
      showMessage("監視サイトを追加しました。最初の比較基準を作成します。 ");
      await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "追加できませんでした");
    } finally {
      setBusy(null);
    }
  };

  const checkSite = async (site: Site) => {
    setBusy(`check-${site.id}`);
    try {
      const result = await api<{ changed: boolean }>(`/api/sites/${site.id}/check`, {
        method: "POST",
        body: "{}",
      });
      showMessage(result.changed ? `${site.name} の更新を検知しました。` : `${site.name} に変化はありません。`);
      await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "確認に失敗しました");
      await loadState();
    } finally {
      setBusy(null);
    }
  };

  const toggleSite = async (site: Site) => {
    setBusy(`toggle-${site.id}`);
    try {
      await api(`/api/sites/${site.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !site.enabled }),
      });
      await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "変更できませんでした");
    } finally {
      setBusy(null);
    }
  };

  const deleteSite = async (site: Site) => {
    if (!window.confirm(`「${site.name}」と更新履歴を削除しますか？`)) return;
    setBusy(`delete-${site.id}`);
    try {
      await api(`/api/sites/${site.id}`, { method: "DELETE" });
      showMessage("監視サイトを削除しました。");
      await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "削除できませんでした");
    } finally {
      setBusy(null);
    }
  };

  const checkAll = async () => {
    setBusy("all");
    try {
      await api("/api/check-all", { method: "POST", body: "{}" });
      showMessage("すべてのサイトを順番に確認しています。");
      window.setTimeout(() => loadState(), 1200);
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "確認を開始できませんでした");
    } finally {
      setBusy(null);
    }
  };

  const openSettings = () => {
    setSettings({ ...state.settings, smtp_password: "" });
    settingsDialog.current?.showModal();
  };

  const saveEmailSettings = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("settings");
    try {
      const result = await api<{ settings: Settings }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      setSettings({ ...result.settings, smtp_password: "" });
      settingsDialog.current?.close();
      showMessage("通知設定を保存しました。");
      await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "設定を保存できませんでした");
    } finally {
      setBusy(null);
    }
  };

  const testEmail = async () => {
    setBusy("test-email");
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(settings) });
      await api("/api/settings/test-email", { method: "POST", body: "{}" });
      showMessage("テストメールを送信しました。");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "テスト送信に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="PageWatch ホーム">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PAGEWATCH</span>
        </a>
        <div className="top-actions">
          <span className="local-chip"><span /> このMacで監視中</span>
          <button className="icon-button" onClick={openSettings} aria-label="通知設定" title="通知設定">
            ⚙
          </button>
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">LOCAL WEBSITE MONITOR</p>
            <h1>変化を、<br /><em>見逃さない。</em></h1>
            <p className="hero-description">
              気になるWebページを静かに見守り、表示される文章や画像に変化があれば知らせます。
              データはすべて、このMacの中だけに保存されます。
            </p>
          </div>
          <div className="hero-meter" aria-label="監視状況">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="meter-center">
              <strong>{state.summary.active}</strong>
              <span>ACTIVE</span>
            </div>
            <span className="meter-label meter-label-top">CHECK</span>
            <span className="meter-label meter-label-bottom">LOCAL</span>
          </div>
        </section>

        <section className="add-panel" aria-labelledby="add-title">
          <div className="section-index">01</div>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ADD A WATCH</p>
              <h2 id="add-title">監視するサイトを追加</h2>
            </div>
            <p>URLを登録すると、最初の内容を比較基準として保存します。</p>
          </div>
          <form className="add-form" onSubmit={addSite}>
            <label className="field field-url">
              <span>サイトURL</span>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/news"
                required
              />
            </label>
            <label className="field field-name">
              <span>表示名 <small>任意</small></span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="研究室ニュース" />
            </label>
            <label className="field field-interval">
              <span>確認間隔</span>
              <select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))}>
                <option value={5}>5分</option>
                <option value={15}>15分</option>
                <option value={30}>30分</option>
                <option value={60}>1時間</option>
                <option value={360}>6時間</option>
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={busy === "add"}>
              <span>{busy === "add" ? "追加中" : "監視を始める"}</span><b aria-hidden="true">↗</b>
            </button>
          </form>
        </section>

        <section className="dashboard-section" aria-labelledby="watch-title">
          <div className="section-title-row">
            <div className="title-with-index">
              <span className="section-index">02</span>
              <div><p className="eyebrow">WATCHING NOW</p><h2 id="watch-title">監視リスト</h2></div>
            </div>
            <button className="secondary-button" onClick={checkAll} disabled={busy === "all"}>
              <span className={busy === "all" ? "spin" : ""}>↻</span> すべて確認
            </button>
          </div>

          <div className="stats-grid">
            <article><span>登録</span><strong>{state.summary.total}</strong><small>SITES</small></article>
            <article><span>監視中</span><strong>{state.summary.active}</strong><small>ACTIVE</small></article>
            <article className={state.summary.changed ? "accent-stat" : ""}><span>更新あり</span><strong>{state.summary.changed}</strong><small>CHANGED</small></article>
            <article className={state.summary.errors ? "error-stat" : ""}><span>エラー</span><strong>{state.summary.errors}</strong><small>ERRORS</small></article>
          </div>

          <div className="site-list" aria-live="polite">
            {loading ? (
              <div className="empty-state"><span className="loader" /> 読み込んでいます</div>
            ) : state.sites.length === 0 ? (
              <div className="empty-state">最初の監視サイトを上のフォームから追加してください。</div>
            ) : state.sites.map((site) => (
              <article className={`site-row ${!site.enabled ? "site-paused" : ""}`} key={site.id}>
                <div className="site-monogram" aria-hidden="true">{site.name.trim().charAt(0).toUpperCase()}</div>
                <div className="site-info">
                  <div className="site-name-line"><h3>{site.name}</h3><StatusBadge status={site.status} /></div>
                  <a href={site.url} target="_blank" rel="noreferrer">{hostname(site.url)} <span>↗</span></a>
                  {site.last_error && <p className="site-error">{site.last_error}</p>}
                </div>
                <div className="site-meta">
                  <span>最終確認</span>
                  <strong>{formatDate(site.last_checked)}</strong>
                  <small>{site.interval_minutes}分ごと</small>
                </div>
                <div className="site-actions">
                  <button onClick={() => checkSite(site)} disabled={busy === `check-${site.id}` || !site.enabled} title="今すぐ確認">
                    <span className={busy === `check-${site.id}` ? "spin" : ""}>↻</span>
                  </button>
                  <button onClick={() => toggleSite(site)} disabled={busy === `toggle-${site.id}`} title={site.enabled ? "一時停止" : "再開"}>
                    {site.enabled ? "Ⅱ" : "▶"}
                  </button>
                  <button className="danger-action" onClick={() => deleteSite(site)} disabled={busy === `delete-${site.id}`} title="削除">×</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="history-section" aria-labelledby="history-title">
          <div className="title-with-index">
            <span className="section-index">03</span>
            <div><p className="eyebrow">RECENT ACTIVITY</p><h2 id="history-title">更新履歴</h2></div>
          </div>
          <div className="timeline">
            {state.events.length === 0 ? (
              <p className="timeline-empty">確認結果がここに記録されます。</p>
            ) : state.events.slice(0, 12).map((item) => (
              <article className="timeline-item" key={item.id}>
                <span className={`timeline-mark mark-${item.kind}`} />
                <time>{formatDate(item.created_at)}</time>
                <div>
                  <h3>{item.site_name}</h3>
                  <p>{item.summary}</p>
                </div>
                <span className="event-label">
                  {item.kind === "changed" ? "更新" : item.kind === "error" ? "エラー" : item.kind === "baseline" ? "開始" : "通知"}
                </span>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer>
        <span>PAGEWATCH / LOCAL ONLY</span>
        <p>あなたの監視データは、このMacから外へ保存されません。</p>
        <a href="#top">TOP ↑</a>
      </footer>

      <dialog className="settings-dialog" ref={settingsDialog} onClose={() => setSettings({ ...state.settings, smtp_password: "" })}>
        <form onSubmit={saveEmailSettings}>
          <div className="dialog-heading">
            <div><p className="eyebrow">NOTIFICATIONS</p><h2>通知設定</h2></div>
            <button type="button" onClick={() => settingsDialog.current?.close()} aria-label="閉じる">×</button>
          </div>
          <label className="toggle-row">
            <span><strong>macOS通知</strong><small>更新時に通知センターへ表示</small></span>
            <input type="checkbox" checked={settings.desktop_notifications} onChange={(e) => setSettings({ ...settings, desktop_notifications: e.target.checked })} />
          </label>
          <label className="toggle-row">
            <span><strong>メール通知</strong><small>SMTPを使って指定先へ送信</small></span>
            <input type="checkbox" checked={settings.email_enabled} onChange={(e) => setSettings({ ...settings, email_enabled: e.target.checked })} />
          </label>
          <div className={`email-fields ${!settings.email_enabled ? "fields-disabled" : ""}`}>
            <label><span>通知先メールアドレス</span><input type="email" value={settings.email_to} onChange={(e) => setSettings({ ...settings, email_to: e.target.value })} disabled={!settings.email_enabled} /></label>
            <div className="field-pair">
              <label><span>SMTPホスト</span><input value={settings.smtp_host} placeholder="smtp.gmail.com" onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })} disabled={!settings.email_enabled} /></label>
              <label><span>ポート</span><input type="number" value={settings.smtp_port} onChange={(e) => setSettings({ ...settings, smtp_port: Number(e.target.value) })} disabled={!settings.email_enabled} /></label>
            </div>
            <label><span>ユーザー名</span><input value={settings.smtp_user} onChange={(e) => setSettings({ ...settings, smtp_user: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>パスワード {settings.smtp_password_set && <small>（保存済み・空欄なら変更なし）</small>}</span><input type="password" value={settings.smtp_password} onChange={(e) => setSettings({ ...settings, smtp_password: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>送信元 <small>空欄ならユーザー名</small></span><input type="email" value={settings.smtp_from} onChange={(e) => setSettings({ ...settings, smtp_from: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label className="inline-check"><input type="checkbox" checked={settings.smtp_ssl} onChange={(e) => setSettings({ ...settings, smtp_ssl: e.target.checked })} disabled={!settings.email_enabled} /> SSL接続を使用（通常の587番ではオフ）</label>
          </div>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={testEmail} disabled={!settings.email_enabled || busy === "test-email"}>テスト送信</button>
            <button type="submit" className="primary-button" disabled={busy === "settings"}><span>設定を保存</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      {message && <div className="toast" role="status">{message}</div>}
    </div>
  );
}

export default App;
