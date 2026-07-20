import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Backend,
  CloudBackend,
  EventItem,
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

const STATUS_TONE: Record<string, string> = {
  waiting: "neutral",
  checking: "working",
  baseline: "good",
  unchanged: "good",
  changed: "changed",
  error: "error",
  paused: "neutral",
};

const SOURCE_KEY = "pagewatch-source";
const ADMIN_KEY = "pagewatch-admin";
const LANG_KEY = "pagewatch-lang";
const DOWNLOAD_URL = "https://github.com/t-shiokawa1/Page-Watch/archive/refs/heads/main.zip";
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

type Lang = "ja" | "en";

// All user-facing copy lives here so the whole UI can switch between Japanese
// and English from one toggle, instead of showing both languages at once.
const T = {
  ja: {
    home: "PageWatch ホーム",
    srcAria: "監視の実行場所",
    srcLocal: "このMac",
    srcCloud: "クラウド",
    langAria: "言語を切り替え",
    settings: "設定",
    close: "閉じる",
    addKicker: "新規追加",
    addTitle: "サイトを追加",
    fUrl: "サイトURL",
    fName: "表示名",
    optional: "任意",
    phName: "ニュース",
    fInterval: "確認間隔",
    addBtn: "監視を始める",
    addBtnBusy: "追加中",
    statTotal: "登録",
    statActive: "監視中",
    statChanged: "更新あり",
    statErrors: "エラー",
    watchKicker: "監視中",
    watchTitle: "監視リスト",
    checkAll: "すべて確認",
    loadingList: "読み込んでいます",
    emptyList: "最初の監視サイトを上のフォームから追加してください。",
    lastChecked: "最終確認",
    checkNow: "今すぐ確認",
    pause: "一時停止",
    resume: "再開",
    del: "削除",
    renameHint: "クリックで表示名を変更",
    tRenamed: "表示名を変更しました。",
    chartKicker: "変化の記録",
    chartTitle: "変化の推移",
    chartUnit: "件 / 14日",
    chartEmpty: "まだ変化は検知されていません。",
    chartSub: (n: number) => `サイト別・1日あたりの検知回数（最大 ${n} 件/日）`,
    today: "今日",
    histKicker: "最近の動き",
    histTitle: "更新履歴",
    histEmpty: "確認結果がここに記録されます。",
    evChanged: "更新",
    evError: "エラー",
    evBaseline: "開始",
    evNotify: "通知",
    notChecked: "まだ確認していません",
    footerCloud: "監視リストと履歴は、あなただけがアクセスできる非公開リポジトリに保存されます。",
    footerLocal: "あなたの監視データは、このMacから外へ保存されません。",
    footerSrcCloud: "クラウド",
    footerSrcLocal: "このMacのみ",
    top: "TOP ↑",
    status: {
      waiting: "確認待ち",
      checking: "確認中",
      baseline: "監視中",
      unchanged: "変化なし",
      changed: "更新あり",
      error: "要確認",
      paused: "一時停止",
    } as Record<string, string>,
    tAddCloud: "クラウドの監視リストに追加しました。初回チェックを開始します。",
    tAddLocal: "監視サイトを追加しました。最初の比較基準を作成します。",
    confirmDelete: (name: string) => `「${name}」と更新履歴を削除しますか？`,
    tDeleted: "監視サイトを削除しました。",
    tIntervalChanged: "確認間隔を変更しました。",
    tTokenSaved: "トークンを保存しました。",
    tTokenRemoved: "トークンを削除しました。",
    tSettingsSaved: "通知設定を保存しました。",
    tTestSent: "テストメールを送信しました。",
    tConnErr: "接続できません",
    tActionErr: "処理に失敗しました",
    tBadUrl: "http:// または https:// で始まるURLを入力してください。",
    tDupUrl: "このURLはすでに登録されています。",
    every: (label: string) => `${label}ごと`,
    // setup: local offline
    loKicker: "はじめに / このMacで監視",
    loTitle: "このMacの監視プログラムが起動していません",
    loLead:
      "「このMac」モードは、あなたのMac上で動く小さなプログラムが監視します。まだ入っていない場合は、次の手順で始めてください（データはこのMacの外に出ません）。",
    loStep1: "下のボタンからアプリ一式（ZIP）をダウンロードします。",
    loStep2a: "ダウンロードした ",
    loStep2b: " をダブルクリックして展開します。",
    loStep3a: "できたフォルダの中の ",
    loStep3b: " をダブルクリックします。",
    loStep4head: "「\"start.command\" is not opened / 開けませんでした」と出た場合",
    loStep4note: "（初回のみ）：",
    loStep4a: "① 「ゴミ箱に入れる」は押さず「完了（Done）」を押す",
    loStep4b: "② Appleメニュー →「システム設定」→「プライバシーとセキュリティ」を開く",
    loStep4c: "③ 下の方の「このまま開く（Open Anyway）」を押し、Touch IDまたはパスワードで承認",
    loStep4d: "④ もう一度 start.command をダブルクリック →「開く」",
    loStep5: "この画面に戻り、下のボタンで再読み込みすると監視リストが表示されます。",
    loStep5note: "macOS標準のPython3で動きます。起動に数十秒かかることがあります。",
    loDownload: "アプリをダウンロード（ZIP）",
    reload: "再読み込み",
    loAltSummary: "うまくいかないとき（ターミナルで解除）",
    loAltP1:
      "ターミナルを開き、次を入力して最後に半角スペースを打ち、展開したフォルダをウインドウにドラッグ＆ドロップしてEnter：",
    loAltDrag: "（ここにフォルダをドラッグ）",
    loAltP2a: "その後 ",
    loAltP2b: " をダブルクリックすれば開きます。",
    // setup: cloud token
    ctKicker: "はじめに / クラウドで監視",
    ctTitle: "クラウド監視を使うには、最初に1回だけ設定が必要です",
    ctLead:
      "「クラウド」モードは、Macを閉じていても監視を続けます。あなたのGitHubアカウントで、専用の合言葉（トークン）を1つ作って貼り付けてください。",
    ctStep1: "下のボタンでGitHubのトークン作成画面を開きます。",
    ctStep1note: "Repository access は pagewatch-data のみ、Permissions は Contents と Actions を「Read and write」に。",
    ctStep2: "作成された文字列（github_pat_…）をコピーします。",
    ctStep3: "「トークンを入力」ボタンから貼り付けて保存します。",
    ctStep3note: "このブラウザにだけ保存されます。",
    ctCreate: "トークンを作成（GitHub）",
    ctEnter: "トークンを入力",
    // cloud dialog
    cdKicker: "設定",
    cdTitle: "クラウド設定",
    cdTokenLabel: "GitHubアクセストークン",
    cdNote1:
      "このブラウザにのみ保存されます。GitHubの「Settings → Developer settings → Fine-grained tokens」で、リポジトリ pagewatch-data だけを対象に Contents（Read and write）と Actions（Read and write）を許可したトークンを作成してください。",
    cdNote2:
      "メール通知は pagewatch-data リポジトリの Settings → Secrets and variables → Actions に SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_TO を登録すると有効になります。",
    save: "保存",
    // notification dialog
    ndKicker: "通知",
    ndTitle: "通知設定",
    ndDesktop: "macOS通知",
    ndDesktopNote: "更新時に通知センターへ表示",
    ndEmail: "メール通知",
    ndEmailNote: "SMTPを使って指定先へ送信",
    ndTo: "通知先メールアドレス",
    ndHost: "SMTPホスト",
    ndPort: "ポート",
    ndUser: "ユーザー名",
    ndPassword: "パスワード",
    ndPasswordSaved: "（保存済み・空欄なら変更なし）",
    ndFrom: "送信元",
    ndFromNote: "空欄ならユーザー名",
    ndSsl: "SSL接続を使用（通常の587番ではオフ）",
    ndTest: "テスト送信",
    ndSave: "設定を保存",
  },
  en: {
    home: "PageWatch home",
    srcAria: "Where checks run",
    srcLocal: "This Mac",
    srcCloud: "Cloud",
    langAria: "Switch language",
    settings: "Settings",
    close: "Close",
    addKicker: "Add a watch",
    addTitle: "Add a site",
    fUrl: "Site URL",
    fName: "Display name",
    optional: "optional",
    phName: "News",
    fInterval: "Check interval",
    addBtn: "Start watching",
    addBtnBusy: "Adding",
    statTotal: "Sites",
    statActive: "Active",
    statChanged: "Changed",
    statErrors: "Errors",
    watchKicker: "Watching now",
    watchTitle: "Watch list",
    checkAll: "Check all",
    loadingList: "Loading",
    emptyList: "Add your first site from the form above.",
    lastChecked: "Last checked",
    checkNow: "Check now",
    pause: "Pause",
    resume: "Resume",
    del: "Delete",
    renameHint: "Click to rename",
    tRenamed: "Display name updated.",
    chartKicker: "Change activity",
    chartTitle: "Changes over time",
    chartUnit: "in 14 days",
    chartEmpty: "No changes detected yet.",
    chartSub: (n: number) => `Detections per day by site (max ${n}/day)`,
    today: "Today",
    histKicker: "Recent activity",
    histTitle: "Recent updates",
    histEmpty: "Check results will appear here.",
    evChanged: "Changed",
    evError: "Error",
    evBaseline: "Started",
    evNotify: "Notified",
    notChecked: "Not checked yet",
    footerCloud: "Your watch list and history are stored in a private repository only you can access.",
    footerLocal: "Your monitoring data is never stored outside this Mac.",
    footerSrcCloud: "CLOUD",
    footerSrcLocal: "LOCAL ONLY",
    top: "TOP ↑",
    status: {
      waiting: "Waiting",
      checking: "Checking",
      baseline: "Watching",
      unchanged: "No change",
      changed: "Changed",
      error: "Check needed",
      paused: "Paused",
    } as Record<string, string>,
    tAddCloud: "Added to the cloud watch list. Running the first check now.",
    tAddLocal: "Site added. Creating the first baseline for comparison.",
    confirmDelete: (name: string) => `Delete “${name}” and its update history?`,
    tDeleted: "Site removed.",
    tIntervalChanged: "Check interval updated.",
    tTokenSaved: "Token saved.",
    tTokenRemoved: "Token removed.",
    tSettingsSaved: "Notification settings saved.",
    tTestSent: "Test email sent.",
    tConnErr: "Can't connect.",
    tActionErr: "Something went wrong.",
    tBadUrl: "Enter a URL that starts with http:// or https://.",
    tDupUrl: "This URL is already registered.",
    every: (label: string) => `every ${label}`,
    // setup: local offline
    loKicker: "Get started / This Mac",
    loTitle: "The monitoring program on this Mac isn't running",
    loLead:
      "“This Mac” mode is powered by a small program running on your Mac. If it isn't set up yet, follow these steps (your data never leaves this Mac).",
    loStep1: "Download the app bundle (ZIP) with the button below.",
    loStep2a: "Double-click the downloaded ",
    loStep2b: " to unzip it.",
    loStep3a: "Double-click ",
    loStep3b: " inside the resulting folder.",
    loStep4head: "If you see “\"start.command\" is not opened”",
    loStep4note: " (first time only):",
    loStep4a: "① Click “Done” — do NOT click “Move to Trash”",
    loStep4b: "② Apple menu → System Settings → Privacy & Security",
    loStep4c: "③ Click “Open Anyway” near the bottom and approve with Touch ID or your password",
    loStep4d: "④ Double-click start.command again → “Open”",
    loStep5: "Come back to this screen and click Reload below to see your watch list.",
    loStep5note: "It runs on the Python 3 that ships with macOS. Startup can take a few tens of seconds.",
    loDownload: "Download the app (ZIP)",
    reload: "Reload",
    loAltSummary: "If it still won't open (unlock via Terminal)",
    loAltP1:
      "Open Terminal, type the following, add a trailing space, then drag the unzipped folder onto the window and press Enter:",
    loAltDrag: "(drag the folder here)",
    loAltP2a: "Then double-click ",
    loAltP2b: " to open it.",
    // setup: cloud token
    ctKicker: "Get started / Cloud",
    ctTitle: "Cloud monitoring needs a one-time setup",
    ctLead:
      "“Cloud” mode keeps watching even while your Mac is closed. Create one access token (a passphrase) on your GitHub account and paste it in.",
    ctStep1: "Open GitHub's token creation screen with the button below.",
    ctStep1note: "Repository access: pagewatch-data only. Permissions: set Contents and Actions to “Read and write”.",
    ctStep2: "Copy the generated string (github_pat_…).",
    ctStep3: "Paste and save it via the “Enter token” button.",
    ctStep3note: "It is stored only in this browser.",
    ctCreate: "Create a token (GitHub)",
    ctEnter: "Enter token",
    // cloud dialog
    cdKicker: "Settings",
    cdTitle: "Cloud settings",
    cdTokenLabel: "GitHub access token",
    cdNote1:
      "Stored only in this browser. In GitHub's Settings → Developer settings → Fine-grained tokens, create a token scoped to only the pagewatch-data repository, with Contents (Read and write) and Actions (Read and write).",
    cdNote2:
      "Email notifications turn on when you add SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASSWORD / EMAIL_TO under the pagewatch-data repository's Settings → Secrets and variables → Actions.",
    save: "Save",
    // notification dialog
    ndKicker: "Notifications",
    ndTitle: "Notifications",
    ndDesktop: "macOS notifications",
    ndDesktopNote: "Show in Notification Center on changes",
    ndEmail: "Email notifications",
    ndEmailNote: "Send via SMTP to the address below",
    ndTo: "Notification email address",
    ndHost: "SMTP host",
    ndPort: "Port",
    ndUser: "Username",
    ndPassword: "Password",
    ndPasswordSaved: "(saved — leave blank to keep)",
    ndFrom: "From",
    ndFromNote: "defaults to username",
    ndSsl: "Use SSL (off for the usual port 587)",
    ndTest: "Send test",
    ndSave: "Save settings",
  },
};

type Dict = (typeof T)["ja"];

function detectLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === "ja" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

// Cloud mode writes to the owner's private data repo, so only the owner can use
// it. Regular visitors see only the local option. The owner unlocks the cloud
// toggle by opening the page once with ?admin (persisted per-browser); locking
// is via ?admin=off.
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

function formatDate(value: string | null, lang: Lang, t: Dict): string {
  if (!value) return t.notChecked;
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
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

// Human-readable interval, computed from minutes so it localizes without
// depending on the backend's (Japanese) choice labels.
function fmtInterval(minutes: number, lang: Lang): string {
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return lang === "ja" ? `${h}時間` : `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  return lang === "ja" ? `${minutes}分` : `${minutes} min`;
}

// Small line icons for the per-row controls. Clearer than the old glyph hacks
// ("Ⅱ" roman numeral for pause, "×" for delete) and they inherit currentColor.
function IconRefresh({ spin }: { spin?: boolean }) {
  return (
    <svg className={`icn${spin ? " spin" : ""}`} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-.9 4.5" />
      <path d="M20 4v6h-6" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function IconPlay() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M7 4.5l13 7.5-13 7.5z" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg className="icn" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M10 4h4M9 7l.7 12.5a1 1 0 0 0 1 1h2.6a1 1 0 0 0 1-1L15 7" />
    </svg>
  );
}

function StatusBadge({ status, t }: { status: string; t: Dict }) {
  const tone = STATUS_TONE[status] || "neutral";
  const label = t.status[status] || t.status.waiting;
  return (
    <span className={`status-badge status-${tone}`}>
      {/* The "changed" state keeps its acid-green fill, but a sparkle (not just a
          calm dot) marks it as "something new" so the green doesn't read as "OK". */}
      {tone === "changed" ? (
        <svg className="status-icon" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
          <path fill="currentColor" d="M12 1.7l2.4 6.9 6.9 2.4-6.9 2.4L12 20.3l-2.4-6.9L2.7 11l6.9-2.4z" />
        </svg>
      ) : (
        <span className="status-dot" />
      )}
      {label}
    </span>
  );
}

// Where a site's favicon might live, most specific first. Project pages served
// from a subpath (e.g. github.io/Repo/) keep their icon under that path, not at
// the domain root, so try the URL's directory before falling back to the root.
function faviconCandidates(rawUrl: string): string[] {
  try {
    const u = new URL(rawUrl);
    const dir = u.pathname.replace(/[^/]*$/, ""); // strip the last path segment
    const names = ["favicon.ico", "favicon.svg", "apple-touch-icon.png", "favicon.png"];
    const bases: string[] = [];
    if (dir && dir !== "/") bases.push(`${u.origin}${dir}`);
    bases.push(`${u.origin}/`);
    return bases.flatMap((base) => names.map((n) => base + n));
  } catch {
    return [];
  }
}

// The site's own favicon (never a third-party service, to match the app's
// "your data stays here" promise). Falls back to the name's first letter.
function SiteIcon({ site }: { site: Site }) {
  const candidates = useMemo(() => faviconCandidates(site.url), [site.url]);
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [site.url]);
  const letter = (site.name.trim() || hostname(site.url)).charAt(0).toUpperCase();
  if (idx >= candidates.length) {
    return <div className="site-monogram" aria-hidden="true">{letter}</div>;
  }
  return (
    <div className="site-favicon" aria-hidden="true">
      <img
        src={candidates[idx]}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setIdx((i) => i + 1)}
        onLoad={(e) => {
          // Some sites answer /favicon.ico with a 1x1 placeholder (or a blank
          // tracking pixel) that "loads" fine but shows as an empty circle.
          // Treat anything tinier than a real icon as a miss and move on.
          const img = e.currentTarget;
          if (img.naturalWidth > 0 && img.naturalWidth < 8) setIdx((i) => i + 1);
        }}
      />
    </div>
  );
}

const DAY_MS = 86_400_000;
const SERIES_COLORS = ["#ff6b3d", "#3868ff", "#51a53e", "#a24bff", "#e0a400", "#d6336c", "#0f9b8e"];

// Per-site line chart of how many changes were detected each day over the last
// two weeks. Events are the only time series we keep, so we bucket "changed"
// events by site and day; each monitored site that changed gets its own line.
function ActivityChart({ events, t }: { events: EventItem[]; t: Dict }) {
  const days = 14;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startMs = start.getTime() - (days - 1) * DAY_MS;

  const bySite = new Map<number, { name: string; counts: number[]; total: number }>();
  for (const event of events) {
    if (event.kind !== "changed") continue;
    const time = new Date(event.created_at);
    time.setHours(0, 0, 0, 0);
    const idx = Math.round((time.getTime() - startMs) / DAY_MS);
    if (idx < 0 || idx >= days) continue;
    let entry = bySite.get(event.site_id);
    if (!entry) {
      entry = { name: event.site_name, counts: Array<number>(days).fill(0), total: 0 };
      bySite.set(event.site_id, entry);
    }
    entry.counts[idx] += 1;
    entry.total += 1;
  }

  const series = [...bySite.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, entry], i) => ({ id, ...entry, color: SERIES_COLORS[i % SERIES_COLORS.length] }));

  const total = series.reduce((sum, s) => sum + s.total, 0);
  const maxY = Math.max(1, ...series.flatMap((s) => s.counts));

  // viewBox space; strokes use non-scaling-stroke so they stay crisp at any width.
  const W = 560, H = 190, padL = 12, padR = 12, padT = 12, padB = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const px = (i: number) => padL + (i / (days - 1)) * plotW;
  const py = (v: number) => padT + plotH - (v / maxY) * plotH;
  const dateLabel = (i: number) => {
    const d = new Date(startMs + i * DAY_MS);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };

  return (
    <section className="chart-card" aria-labelledby="chart-title">
      <div className="chart-head">
        <div><p className="eyebrow">{t.chartKicker}</p><h2 id="chart-title">{t.chartTitle}</h2></div>
        <span className="chart-total">{total}<small>{t.chartUnit}</small></span>
      </div>

      {total === 0 ? (
        <p className="chart-empty">{t.chartEmpty}</p>
      ) : (
        <>
          <p className="chart-sub">{t.chartSub(maxY)}</p>
          <svg className="line-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t.chartSub(maxY)}>
            <line className="grid-line" x1={padL} y1={py(0)} x2={W - padR} y2={py(0)} vectorEffect="non-scaling-stroke" />
            <line className="grid-line grid-top" x1={padL} y1={py(maxY)} x2={W - padR} y2={py(maxY)} vectorEffect="non-scaling-stroke" />
            {series.map((s) => (
              <g key={s.id}>
                <polyline
                  className="series-line"
                  points={s.counts.map((v, i) => `${px(i)},${py(v)}`).join(" ")}
                  style={{ stroke: s.color }}
                  vectorEffect="non-scaling-stroke"
                />
                {s.counts.map((v, i) =>
                  v > 0 ? <circle key={i} r={3.5} cx={px(i)} cy={py(v)} style={{ fill: s.color }} /> : null,
                )}
              </g>
            ))}
          </svg>
          <div className="chart-axis">
            <span>{dateLabel(0)}</span>
            <span>{dateLabel(Math.floor((days - 1) / 2))}</span>
            <span>{t.today}</span>
          </div>
          <div className="chart-legend">
            {series.map((s) => (
              <span key={s.id} className="legend-item">
                <i style={{ background: s.color }} />{s.name}<b>{s.total}</b>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function App() {
  const [isAdmin] = useState(detectAdmin);
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = T[lang];
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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");

  const toggleLang = () => {
    const next: Lang = lang === "ja" ? "en" : "ja";
    localStorage.setItem(LANG_KEY, next);
    document.documentElement.lang = next;
    setLang(next);
  };

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

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
        if (!quiet) setMessage(error instanceof Error ? error.message : t.tConnErr);
      } finally {
        setLoading(false);
      }
    },
    [backend, t],
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
      showMessage(error instanceof Error ? error.message : t.tActionErr);
    } finally {
      setBusy(null);
    }
  };

  const addSite = (event: FormEvent) => {
    event.preventDefault();
    // Validate on the client for both backends so the URL rules and messages
    // are identical whether the check runs locally or in the cloud.
    const trimmedUrl = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmedUrl);
    } catch {
      showMessage(t.tBadUrl);
      return;
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      showMessage(t.tBadUrl);
      return;
    }
    if (state.sites.some((s) => s.url === trimmedUrl)) {
      showMessage(t.tDupUrl);
      return;
    }
    run("add", async () => {
      await backend.addSite({ name, url: trimmedUrl, interval_minutes: interval });
      setName("");
      setUrl("");
      return backend.kind === "cloud" ? t.tAddCloud : t.tAddLocal;
    });
  };

  const deleteSite = (site: Site) => {
    if (!window.confirm(t.confirmDelete(site.name))) return;
    run(`delete-${site.id}`, async () => {
      await backend.deleteSite(site);
      return t.tDeleted;
    });
  };

  const startRename = (site: Site) => {
    setEditingId(site.id);
    setEditName(site.name);
  };

  const commitRename = (site: Site) => {
    // Escape and Enter both clear editingId synchronously, so a stray blur that
    // fires afterwards would otherwise re-commit (double save) or resurrect a
    // cancelled edit. Bail out unless this row is still the one being edited.
    if (editingId !== site.id) return;
    const value = editName.trim();
    setEditingId(null);
    if (!value || value === site.name) return;
    run(`rename-${site.id}`, async () => {
      await backend.renameSite(site, value);
      return t.tRenamed;
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
    showMessage(tokenDraft ? t.tTokenSaved : t.tTokenRemoved);
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
      return t.tSettingsSaved;
    });
  };

  const testEmail = () => {
    run(
      "test-email",
      async () => {
        if (!local) return;
        await local.saveSettings(settings);
        await local.testEmail();
        return t.tTestSent;
      },
      false,
    );
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label={t.home}>
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>PAGEWATCH</span>
        </a>
        <div className="top-actions">
          {isAdmin && (
            <div className="source-toggle" role="tablist" aria-label={t.srcAria}>
              <button
                role="tab"
                aria-selected={source === "local"}
                className={source === "local" ? "source-active" : ""}
                onClick={() => switchSource("local")}
              >
                {t.srcLocal}
              </button>
              <button
                role="tab"
                aria-selected={source === "cloud"}
                className={source === "cloud" ? "source-active" : ""}
                onClick={() => switchSource("cloud")}
              >
                {t.srcCloud}
              </button>
            </div>
          )}
          <button className="lang-button" onClick={toggleLang} aria-label={t.langAria}>
            {lang === "ja" ? "EN" : "日本語"}
          </button>
          <button className="icon-button" onClick={openSettings} aria-label={t.settings} title={t.settings}>
            ⚙
          </button>
        </div>
      </header>

      <main id="top">
        {setupNeeded === "local-offline" && (
          <section className="setup-card" aria-label={t.loTitle}>
            <p className="eyebrow">{t.loKicker}</p>
            <h2>{t.loTitle}</h2>
            <p className="setup-lead">{t.loLead}</p>
            <ol>
              <li>{t.loStep1}</li>
              <li>{t.loStep2a}<code>Page-Watch-main.zip</code>{t.loStep2b}</li>
              <li>{t.loStep3a}<code>start.command</code>{t.loStep3b}</li>
              <li>
                <strong>{t.loStep4head}</strong>{t.loStep4note}
                <small>{t.loStep4a}</small>
                <small>{t.loStep4b}</small>
                <small>{t.loStep4c}</small>
                <small>{t.loStep4d}</small>
              </li>
              <li>
                {t.loStep5}
                <small>{t.loStep5note}</small>
              </li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={DOWNLOAD_URL}>{t.loDownload}</a>
              <button className="secondary-button" onClick={() => run("reload", () => loadState(), false)}>
                <span className={busy === "reload" ? "spin" : ""}>↻</span> {t.reload}
              </button>
            </div>
            <details className="setup-alt">
              <summary>{t.loAltSummary}</summary>
              <p>{t.loAltP1}</p>
              <p><code>xattr -dr com.apple.quarantine </code>{t.loAltDrag}</p>
              <p>{t.loAltP2a}<code>start.command</code>{t.loAltP2b}</p>
            </details>
          </section>
        )}
        {setupNeeded === "cloud-token" && (
          <section className="setup-card" aria-label={t.ctTitle}>
            <p className="eyebrow">{t.ctKicker}</p>
            <h2>{t.ctTitle}</h2>
            <p className="setup-lead">{t.ctLead}</p>
            <ol>
              <li>
                {t.ctStep1}
                <small>{t.ctStep1note}</small>
              </li>
              <li>{t.ctStep2}</li>
              <li>{t.ctStep3}<small>{t.ctStep3note}</small></li>
            </ol>
            <div className="setup-actions">
              <a className="setup-button" href={TOKEN_URL} target="_blank" rel="noreferrer">{t.ctCreate}</a>
              <button
                className="secondary-button"
                onClick={() => {
                  setTokenDraft(getCloudToken());
                  cloudDialog.current?.showModal();
                }}
              >
                {t.ctEnter}
              </button>
            </div>
          </section>
        )}
        <div className="layout">
        <aside className="side">
        <section className="add-panel" aria-labelledby="add-title">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">{t.addKicker}</p>
              <h2 id="add-title">{t.addTitle}</h2>
            </div>
          </div>
          <form className="add-form" onSubmit={addSite}>
            <label className="field field-url">
              <span>{t.fUrl}</span>
              <input
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com/news"
                required
              />
            </label>
            <label className="field field-name">
              <span>{t.fName} <small>{t.optional}</small></span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t.phName} />
            </label>
            <label className="field field-interval">
              <span>{t.fInterval}</span>
              <select value={interval} onChange={(event) => setIntervalValue(Number(event.target.value))}>
                {backend.intervalChoices.map((choice) => (
                  <option key={choice.value} value={choice.value}>{fmtInterval(choice.value, lang)}</option>
                ))}
              </select>
            </label>
            <button className="primary-button" type="submit" disabled={busy === "add"}>
              <span>{busy === "add" ? t.addBtnBusy : t.addBtn}</span><b aria-hidden="true">↗</b>
            </button>
          </form>
        </section>

        <div className="stats-grid">
          <article><span>{t.statTotal}</span><strong>{state.summary.total}</strong></article>
          <article><span>{t.statActive}</span><strong>{state.summary.active}</strong></article>
          <article className={state.summary.changed ? "accent-stat" : ""}><span>{t.statChanged}</span><strong>{state.summary.changed}</strong></article>
          <article className={state.summary.errors ? "error-stat" : ""}><span>{t.statErrors}</span><strong>{state.summary.errors}</strong></article>
        </div>

        <ActivityChart events={state.events} t={t} />
        </aside>

        <div className="content">
        <section className="dashboard-section" aria-labelledby="watch-title">
          <div className="section-title-row">
            <div className="title-with-index">
              <div><p className="eyebrow">{t.watchKicker}</p><h2 id="watch-title">{t.watchTitle}</h2></div>
            </div>
            <button
              className="secondary-button"
              onClick={() => run("all", () => backend.checkAll(), false)}
              disabled={busy === "all"}
            >
              <span className={busy === "all" ? "spin" : ""}>↻</span> {t.checkAll}
            </button>
          </div>

          <div className="site-list" aria-live="polite">
            {loading ? (
              <div className="empty-state"><span className="loader" /> {t.loadingList}</div>
            ) : state.sites.length === 0 ? (
              <div className="empty-state">{t.emptyList}</div>
            ) : state.sites.map((site) => (
              <article className={`site-row ${!site.enabled ? "site-paused" : ""}`} key={site.id}>
                <SiteIcon site={site} />
                <div className="site-info">
                  <div className="site-name-line">
                    {editingId === site.id ? (
                      <input
                        className="name-edit"
                        value={editName}
                        autoFocus
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(site);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onBlur={() => commitRename(site)}
                        aria-label={t.fName}
                      />
                    ) : (
                      <h3
                        className="site-name"
                        role="button"
                        tabIndex={0}
                        onClick={() => startRename(site)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            startRename(site);
                          }
                        }}
                        title={t.renameHint}
                        aria-label={`${site.name} — ${t.renameHint}`}
                      >
                        {site.name}
                      </h3>
                    )}
                    <StatusBadge status={site.status} t={t} />
                  </div>
                  <a href={site.url} target="_blank" rel="noreferrer">{hostname(site.url)} <span>↗</span></a>
                  {site.last_error && <p className="site-error">{site.last_error}</p>}
                </div>
                <div className="site-meta">
                  <span>{t.lastChecked}</span>
                  <strong>{formatDate(site.last_checked, lang, t)}</strong>
                  <select
                    className="interval-select"
                    value={site.interval_minutes}
                    onChange={(event) =>
                      run(`interval-${site.id}`, async () => {
                        await backend.setInterval(site, Number(event.target.value));
                        return t.tIntervalChanged;
                      })
                    }
                    disabled={busy === `interval-${site.id}`}
                    aria-label={t.fInterval}
                  >
                    {backend.intervalChoices.map((choice) => (
                      <option key={choice.value} value={choice.value}>{t.every(fmtInterval(choice.value, lang))}</option>
                    ))}
                    {!backend.intervalChoices.some((c) => c.value === site.interval_minutes) && (
                      <option value={site.interval_minutes}>{t.every(fmtInterval(site.interval_minutes, lang))}</option>
                    )}
                  </select>
                </div>
                <div className="site-actions">
                  <button
                    onClick={() => run(`check-${site.id}`, () => backend.checkSite(site))}
                    disabled={busy === `check-${site.id}` || !site.enabled}
                    title={t.checkNow}
                    aria-label={t.checkNow}
                  >
                    <IconRefresh spin={busy === `check-${site.id}`} />
                  </button>
                  <button
                    onClick={() => run(`toggle-${site.id}`, () => backend.toggleSite(site))}
                    disabled={busy === `toggle-${site.id}`}
                    title={site.enabled ? t.pause : t.resume}
                    aria-label={site.enabled ? t.pause : t.resume}
                  >
                    {site.enabled ? <IconPause /> : <IconPlay />}
                  </button>
                  <button className="danger-action" onClick={() => deleteSite(site)} disabled={busy === `delete-${site.id}`} title={t.del} aria-label={t.del}><IconTrash /></button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="history-section" aria-labelledby="history-title">
          <div className="title-with-index">
            <div><p className="eyebrow">{t.histKicker}</p><h2 id="history-title">{t.histTitle}</h2></div>
          </div>
          <div className="timeline">
            {state.events.length === 0 ? (
              <p className="timeline-empty">{t.histEmpty}</p>
            ) : state.events.slice(0, 8).map((item) => (
              <article className="timeline-item" key={item.id}>
                <span className={`timeline-mark mark-${item.kind}`} />
                <time>{formatDate(item.created_at, lang, t)}</time>
                <div>
                  <h3>{item.site_name}</h3>
                  <p>{item.summary}</p>
                </div>
                <span className="event-label">
                  {item.kind === "changed" ? t.evChanged : item.kind === "error" ? t.evError : item.kind === "baseline" ? t.evBaseline : t.evNotify}
                </span>
              </article>
            ))}
          </div>
        </section>
        </div>
        </div>
      </main>

      <footer>
        <span>PAGEWATCH / {source === "cloud" ? t.footerSrcCloud : t.footerSrcLocal}</span>
        <p>{source === "cloud" ? t.footerCloud : t.footerLocal}</p>
        <a href="#top">{t.top}</a>
      </footer>

      <dialog className="settings-dialog" ref={cloudDialog}>
        <form onSubmit={saveToken}>
          <div className="dialog-heading">
            <div><p className="eyebrow">{t.cdKicker}</p><h2>{t.cdTitle}</h2></div>
            <button type="button" onClick={() => cloudDialog.current?.close()} aria-label={t.close}>×</button>
          </div>
          <div className="email-fields">
            <label>
              <span>{t.cdTokenLabel}</span>
              <input
                type="password"
                value={tokenDraft}
                onChange={(event) => setTokenDraft(event.target.value)}
                placeholder="github_pat_..."
              />
            </label>
            <p className="dialog-note">{t.cdNote1}</p>
            <p className="dialog-note">{t.cdNote2}</p>
          </div>
          <div className="dialog-actions">
            <button type="submit" className="primary-button"><span>{t.save}</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      <dialog className="settings-dialog" ref={settingsDialog} onClose={() => state.settings && setSettings({ ...state.settings, smtp_password: "" })}>
        <form onSubmit={saveEmailSettings}>
          <div className="dialog-heading">
            <div><p className="eyebrow">{t.ndKicker}</p><h2>{t.ndTitle}</h2></div>
            <button type="button" onClick={() => settingsDialog.current?.close()} aria-label={t.close}>×</button>
          </div>
          <label className="toggle-row">
            <span><strong>{t.ndDesktop}</strong><small>{t.ndDesktopNote}</small></span>
            <input type="checkbox" checked={settings.desktop_notifications} onChange={(e) => setSettings({ ...settings, desktop_notifications: e.target.checked })} />
          </label>
          <label className="toggle-row">
            <span><strong>{t.ndEmail}</strong><small>{t.ndEmailNote}</small></span>
            <input type="checkbox" checked={settings.email_enabled} onChange={(e) => setSettings({ ...settings, email_enabled: e.target.checked })} />
          </label>
          <div className={`email-fields ${!settings.email_enabled ? "fields-disabled" : ""}`}>
            <label><span>{t.ndTo}</span><input type="email" value={settings.email_to} onChange={(e) => setSettings({ ...settings, email_to: e.target.value })} disabled={!settings.email_enabled} /></label>
            <div className="field-pair">
              <label><span>{t.ndHost}</span><input value={settings.smtp_host} placeholder="smtp.gmail.com" onChange={(e) => setSettings({ ...settings, smtp_host: e.target.value })} disabled={!settings.email_enabled} /></label>
              <label><span>{t.ndPort}</span><input type="number" value={settings.smtp_port} onChange={(e) => setSettings({ ...settings, smtp_port: Number(e.target.value) })} disabled={!settings.email_enabled} /></label>
            </div>
            <label><span>{t.ndUser}</span><input value={settings.smtp_user} onChange={(e) => setSettings({ ...settings, smtp_user: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>{t.ndPassword} {settings.smtp_password_set && <small>{t.ndPasswordSaved}</small>}</span><input type="password" value={settings.smtp_password} onChange={(e) => setSettings({ ...settings, smtp_password: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label><span>{t.ndFrom} <small>{t.ndFromNote}</small></span><input type="email" value={settings.smtp_from} onChange={(e) => setSettings({ ...settings, smtp_from: e.target.value })} disabled={!settings.email_enabled} /></label>
            <label className="inline-check"><input type="checkbox" checked={settings.smtp_ssl} onChange={(e) => setSettings({ ...settings, smtp_ssl: e.target.checked })} disabled={!settings.email_enabled} /> {t.ndSsl}</label>
          </div>
          <div className="dialog-actions">
            <button type="button" className="secondary-button" onClick={testEmail} disabled={!settings.email_enabled || busy === "test-email"}>{t.ndTest}</button>
            <button type="submit" className="primary-button" disabled={busy === "settings"}><span>{t.ndSave}</span><b>↗</b></button>
          </div>
        </form>
      </dialog>

      {message && <div className="toast" role="status">{message}</div>}
    </div>
  );
}

export default App;
