import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Backend,
  CloudBackend,
  LocalBackend,
  Settings,
  Site,
  SourceKind,
  getCloudToken,
  setCloudToken,
} from "./backend";

const emptySettings: Settings = {
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
};

const emptyState: AppState = {
  summary: { total: 0, active: 0, changed: 0, errors: 0 },
  sites: [],
  events: [],
  settings: null,
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

const SOURCE_KEY = "pagewatch-source";
const ADMIN_KEY = "pagewatch-admin";
const DOWNLOAD_URL = "https://github.com/t-shiokawa1/Page-Watch/archive/refs/heads/main.zip";
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

// Cloud mode writes to the owner's private data repo, so only the owner can use
// it. Regular visitors see only "このMac". The owner unlocks the cloud toggle by
// opening the page once with ?admin (persisted per-browser); locking is via ?admin=off.
function detectAdmin(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.has("admin")) {
    const on = params.get("admin") !== "off";
    if (on) localStorage.setItem(ADMIN_KEY, "1");
    else localStorage.removeItem(ADMIN_KEY);
    params.delete("admin");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
    return on;
  }
  return localStorage.getItem(ADMIN_KEY) === "1";
}

function defaultSource(isAdmin: boolean): SourceKind {
  if (!isAdmin) return "local";
  const saved = localStorage.getItem(SOURCE_KEY);
  if (saved === "local" || saved === "cloud") return saved;
  return window.location.hostname.endsWith("github.io") ? "cloud" : "local";
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
  const [isAdmin] = useState(detectAdmin);
  const [source, setSource] = useState<SourceKind>(() => defaultSource(isAdmin));
  const backend: Backend = useMemo(
    () => (source === "cloud" ? new CloudBackend() : new LocalBackend()),
    [source],
  );
  const [state, setState] = useState<AppState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [interval, setIntervalValue] = useState(60);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const cloudDialog = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<Settings>(emptySettings);
  const [tokenDraft, setTokenDraft] = useState("");
  const [hasToken, setHasToken] = useState(() => !!getCloudToken());
  const [connError, setConnError] = useState(false);

  const loadState = useCallback(
    async (quiet = false) => {
      try {
        const next = await backend.loadState();
        setState(next);
        setConnError(false);
        if (next.settings) {
          setSettings((current) =>
            settingsDialog.current?.open ? current : { ...next.settings!, smtp_password: "" },
          );
        }
      } catch (error) {
        setConnError(true);
        if (!quiet) setMessage(error instanceof Error ? error.message : "接続できません");
      } finally {
        setLoading(false);
      }
    },
    [backend],
  );

  // What the person needs to do before this mode can work.
  const setupNeeded: "local-offline" | "cloud-token" | null =
    backend.kind === "cloud" && !hasToken
      ? "cloud-token"
      : backend.kind === "local" && connError
        ? "local-offline"
        : null;

  useEffect(() => {
    setState(emptyState);
    setLoading(true);
    loadState();
    const period = backend.kind === "cloud" ? 20000 : 5000;
    const timer = window.setInterval(() => loadState(true), period);
    return () => window.clearInterval(timer);
  }, [backend, loadState]);

  useEffect(() => {
    if (!backend.intervalChoices.some((c) => c.value === interval)) {
      setIntervalValue(60);
    }
  }, [backend, interval]);

  const switchSource = (next: SourceKind) => {
    localStorage.setItem(SOURCE_KEY, next);
    setSource(next);
    if (next === "cloud" && !getCloudToken()) {
      setTokenDraft("");
      cloudDialog.current?.showModal();
    }
  };

  const showMessage = (value: string) => {
    setMessage(value);
    window.setTimeout(() => setMessage(null), 4500);
  };

  const run = async (key: string, action: () => Promise<string | void>, reload = true) => {
    setBusy(key);
    try {
      const result = await action();
      if (typeof result === "string") showMessage(result);
      if (reload) await loadState();
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "処理に失敗しました");
    } finally {
      setBusy(null);
    }
  };

  const addSite = (event: FormEvent) => {
    event.preventDefault();
    run("add", async () => {
      await backend.addSite({ name, url, interval_minutes: interval });
      setName("");
      setUrl("");
      return backend.kind === "cloud"
        ? "クラウドの監視リストに追加しました。初回チェックを開始します。"
        : "監視サイトを追加しました。最初の比較基準を作成します。";
    });
  };

  const deleteSite = (site: Site) => {
    if (!window.confirm(`「${site.name}」と更新履歴を削除しますか？`)) return;
    run(`delete-${site.id}`, async () => {
      await backend.deleteSite(site);
      return "監視サイトを削除しました。";
    });
  };

  const openSettings = () => {
    if (backend.kind === "cloud") {
      setTokenDraft(getCloudToken());
      cloudDialog.current?.showModal();
    } else {
      if (state.settings) setSettings({ ...state.settings, smtp_password: "" });
      settingsDialog.current?.showModal();
    }
  };

  const saveToken = (event: FormEvent) => {
    event.preventDefault();
    setCloudToken(tokenDraft);
    setHasToken(!!tokenDraft.trim());
    cloudDialog.current?.close();
    showMessage(tokenDraft ? "トークンを保存しました。" : "トークンを削除しました。");
    loadState();
  };

  const local = backend.kind === "local" ? (backend as LocalBackend) : null;

  const saveEmailSettings = (event: FormEvent) => {
    event.preventDefault();
    run("settings", async () => {
      if (!local) return;
      const saved = await local.saveSettings(settings);
      setSettings({ ...saved, smtp_password: "" });
      settingsDialog.current?.close();
      return "通知設定を保存しました。";
    });
  };

  const testEmail = () => {
    run(
      "test-email",
      async () => {
        if (!local) return;
        await local.saveSettings(settings);
        await local.testEmail();
        return "テストメールを送信しました。";
      },
      false,
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="PageWatch ホーム">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PAGEWATCH</span>
        </a>
        <div className="top-actions">
          {isAdmin && (
            <div className="source-toggle" role="tablist" aria-label="監視の実行場所">
              <button
                role="tab"
                aria-selected={source === "local"}
                className={source === "local" ? "source-active" : ""}
                onClick={() => switchSource("local")}
              >
                このMac
              </button>
              <button
                role="tab"
                aria-selected={source === "cloud"}
                className={source === "cloud" ? "source-active" : ""}
                onClick={() => switchSource("cloud")}
              >
                クラウド
              </button>
            </div>
          )}
          <button className="icon-button" onClick={openSettings} aria-label="設定" title="設定">
            ⚙
          </button>
        </div>
      </header>

      <main id="top">
        {setupNeeded === "local-offline" && (
          <section className="setup-card" aria-label="このMacで監視を始める手順">
            <p className="eyebrow">はじめに / このMacで監視</p>
            <h2>このMacの監視プログラムが起動していません</h2>
            <p className="setup-lead">
              「このMac」モードは、あなたのMac上で動く小さなプログラムが監視します。
              まだ入っていない場合は、次の手順で始めてください（データはこのMacの外に出ません）。
            </p>
            <ol>
              <li>下のボタンからアプリ一式（ZIP）をダウンロードします。</li>
              <li>ダウンロードした <code>Page-Watch-main.zip</code> をダブルクリックして展開します。</li>
              <li>できたフォルダの中の <code>start.command</code> をダブルクリックします。</li>
              <li>
                <strong>「"start.command" is not opened / 開けませんでした」と出た場合</strong>（初回のみ）：
                <small>① <strong>「ゴミ箱に入れる」は押さず</strong>「完了（Done）」を押す</small>
                <small>② Appleメニュー →「システム設定」→「プライバシーとセキュリティ」を開く</small>
                <small>③ 下の方の「このまま開く（Open Anyway）」を押し、Touch IDまたはパスワードで承認</small>
                <small>④ もう一度 <code>start.command</code> をダブルクリック →「開く」</small>
              </li>
              <li>
                この画面に戻り、下のボタンで再読み込みすると監視リストが表示されます。
                <small>macOS標準のPython3で動きます。起動に数十秒かかることがあります。</small>
              </li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={DOWNLOAD_URL}>アプリをダウンロード（ZIP）</a>
              <button className="secondary-button" onClick={() => run("reload", () => loadState(), false)}>
                <span className={busy === "reload" ? "spin" : ""}>↻</span> 再読み込み
              </button>
            </div>
            <details className="setup-alt">
              <summary>うまくいかないとき（ターミナルで解除）</summary>
              <p>
                ターミナルを開き、次を入力して最後に半角スペースを打ち、展開したフォルダをウインドウにドラッグ＆ドロップしてEnter：
              </p>
              <p><code>xattr -dr com.apple.quarantine </code>（ここにフォルダをドラッグ）</p>
              <p>その後 <code>start.command</code> をダブルクリックすれば開きます。</p>
            </details>
          </section>
        )}
        {setupNeeded === "cloud-token" && (
          <section className="setup-card" aria-label="クラウドで監視を始める手順">
            <p className="eyebrow">はじめに / クラウドで監視</p>
            <h2>クラウド監視を使うには、最初に1回だけ設定が必要です</h2>
            <p className="setup-lead">
              「クラウド」モードは、Macを閉じていても監視を続けます。
              あなたのGitHubアカウントで、専用の合言葉（トークン）を1つ作って貼り付けてください。
            </p>
            <ol>
              <li>
                下のボタンでGitHubのトークン作成画面を開きます。
                <small>Repository access は <code>pagewatch-data</code> のみ、Permissions は Contents と Actions を「Read and write」に。</small>
              </li>
              <li>作成された文字列（<code>github_pat_…</code>）をコピーします。</li>
              <li>「トークンを入力」ボタンから貼り付けて保存します。<small>このブラウザにだけ保存されます。</small></li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={TOKEN_URL} target="_blank" rel="noreferrer">トークンを作成（GitHub）</a>
              <button
                className="secondary-button"
                onClick={() => {
                  setTokenDraft(getCloudToken());
                  cloudDialog.current?.showModal();
                }}
              >
                トークンを入力
              </button>
            </div>
          </section>
        )}
        <section className="add-panel add-panel-first" aria-labelledby="add-title">
          <div className="section-index">01</div>
          <div className="panel-heading">
            <div>
              <p className="eyebrow">ADD A WATCH</p>
              <h2 id="add-title">監視するサイトを追加</h2>
            </div>
            <p>
              {backend.kind === "cloud"
                ? "クラウド（GitHub Actions）が定期チェックします。Macを閉じていても動きます。"
                : "このMacが定期チェックします。データはこのMacの外へ出ません。"}
            </p>
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
                {backend.intervalChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{choice.label}</option>
                ))}
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
            <button
              className="secondary-button"
              onClick={() => run("all", () => backend.checkAll(), false)}
              disabled={busy === "all"}
            >
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
                  <select
                    className="interval-select"
                    value={site.interval_minutes}
                    onChange={(event) =>
                      run(`interval-${site.id}`, async () => {
                        await backend.setInterval(site, Number(event.target.value));
                        return "確認間隔を変更しました。";
                      })
                    }
                    disabled={busy === `interval-${site.id}`}
                    aria-label="確認間隔"
                  >
                    {backend.intervalChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>{choice.label}ごと</option>
                    ))}
                    {!backend.intervalChoices.some((c) => c.value === site.interval_minutes) && (
                      <option value={site.interval_minutes}>{site.interval_minutes}分ごと</option>
                    )}
                  </select>
                </div>
                <div className="site-actions">
                  <button
                    onClick={() => run(`check-${site.id}`, () => backend.checkSite(site))}
                    disabled={busy === `check-${site.id}` || !site.enabled}
                    title="今すぐ確認"
                  >
                    <span className={busy === `check-${site.id}` ? "spin" : ""}>↻</span>
                  </button>
                  <button
                    onClick={() => run(`toggle-${site.id}`, () => backend.toggleSite(site))}
                    disabled={busy === `toggle-${site.id}`}
                    title={site.enabled ? "一時停止" : "再開"}
                  >
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
        <span>PAGEWATCH / {source === "cloud" ? "CLOUD" : "LOCAL ONLY"}</span>
        <p>
          {source === "cloud"
            ? "監視リストと履歴は、あなただけがアクセスできる非公開リポジトリに保存されます。"
            : "あなたの監視データは、このMacから外へ保存されません。"}
        </p>
        <a href="#top">TOP ↑</a>
      </footer>

      <dialog className="settings-dialog" ref={cloudDialog}>
        <form onSubmit={saveToken}>
          <div className="dialog-heading">
            <div><p className="eyebrow">CLOUD</p><h2>クラウド設定</h2></div>
            <button type="button" onClick={() => cloudDialog.current?.close()} aria-label="閉じる">×</button>
          </div>
          <div className="email-fields">
            <label>
              <span>GitHubアクセストークン</span>
              <input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="github_pat_..."
              />
            </label>
            <p className="dialog-note">
              このブラウザにのみ保存されます。GitHubの
              「Settings → Developer settings → Fine-grained tokens」で、
              リポジトリ <code>pagewatch-data</code> だけを対象に
              Contents（Read and write）と Actions（Read and write）を許可した
              トークンを作成してください。
            </p>
            <p className="dialog-note">
              メール通知は <code>pagewatch-data</code> リポジトリの
              Settings → Secrets and variables → Actions に
              SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_TO を登録すると有効になります。
            </p>
          </div>
          <div className="dialog-actions">
            <button type="submit" className="primary-button"><span>保存</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      <dialog className="settings-dialog" ref={settingsDialog} onClose={() => state.settings && setSettings({ ...state.settings, smtp_password: "" })}>
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
