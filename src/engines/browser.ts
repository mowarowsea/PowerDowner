import fs from 'node:fs';
import path from 'node:path';
import type { BrowserContext, Page, Download, Route } from 'playwright-core';
import type { Config } from '../config.js';
import type { Job, EngineStatus, ResolvedDownload } from '../types.js';
import { bus, log } from '../events.js';
import { toast } from '../notify.js';
import type { Progress } from './aria2.js';
import { drive, snapshot, isXfsLikely, FILE_EXT, type DriverContext } from '../drivers/xfs.js';

/**
 * 人間ハンドオフ用のブラウザエンジン。
 *
 * Cloudflare Turnstile のように JD2 が扱えない人間判定は、機械で突破せず人間に通してもらう。
 * ただし人間の仕事は判定そのものだけに絞る: Free Download ボタン、待ち時間、本物の
 * Download ボタン、直リンクの取得はサイト自動操作ドライバ (drivers/) が進める。
 * ブラウザがファイルを落とし始めた瞬間に URL と Cookie を横取りし、aria2 に引き継ぐ。
 *
 * 偽ボタン対策: 同一サイト以外のサブリソースとポップアップは遮断する。
 * 自動操作できないページは手動モードに落とし、HTML とスクリーンショットを data/debug に残す。
 *
 * 同時実行: 別サイトなら browser.maxConcurrent まで並行して進める。
 * 同じサイトは 1 件ずつ (無料枠の同時ダウンロード制限に引っかかるため)。
 */

export interface BrowserCallbacks {
  onHandoff(jobId: string, resolved: ResolvedDownload): void;
  onProgress(jobId: string, p: Progress): void;
  onDone(jobId: string, filename: string | null): void;
  onFailed(jobId: string, error: string): void;
  onWaitingHuman(jobId: string, waiting: boolean, detail: string): void;
  /**
   * サイト側の無料ダウンロード間隔にかかった / サイトが落ちている。resumeAt (epoch ms) に自動で再開する。
   * キューが別の候補へ移した場合は true を返す。そのときエンジンはこのジョブを待たずに手放す
   */
  onSiteWait(jobId: string, resumeAt: number, reason: string): boolean;
}

interface Current {
  job: Job;
  /** ジョブ URL の登録可能ドメイン。同じサイトを同時に叩かないための鍵 (リダイレクトしても変えない) */
  base: string;
  /**
   * 「同一サイト」とみなすドメイン。frdl.io → frdl.hk のようにサイトが別ドメインへ
   * 飛ばすことがあるので、メインフレームの遷移先を足していく。
   * ここが古いままだと自分のサイトの JS と画像まで遮断してページが壊れる。
   */
  bases: Set<string>;
  page: Page;
  timer: NodeJS.Timeout;
  handled: boolean;
  downloadSeen: boolean;
  attempts: number;
  /** 遮断した要求。ページが動かないときの原因調査用 (/api/jobs/:id/dump で見る) */
  blocked: string[];
  /** ページのコンソール出力。Turnstile は失敗理由をエラーコードで console に出す */
  console: string[];
  /**
   * このジョブのページが開いたポップアップの数。クリックがポップアンダー広告を
   * 開いただけで本来の遷移をしないサイト (dailyuploads) があるので、ドライバが
   * 「空振りのクリック」を見分けるのに使う。
   */
  popups: number;
  /**
   * このサイトで強い広告対策 (browser.adGuardHosts) を効かせるか。
   * window.open の封じ込めと、メインフレームを他所へ飛ばす遷移の遮断が有効になる。
   */
  guard: boolean;
  /** 広告のページから引き返した回数。止めそこねた時の保険なので、何度も繰り返さない */
  recoveries: number;
}

interface Waiting {
  job: Job;
  base: string;
  notBefore: number;
  /** サイトダウンで再投入した回数 */
  attempts: number;
}

/** サイト側が落ちている (Cloudflare 5xx など) ときの再試行間隔と回数 */
const SITE_DOWN_WAIT = 10 * 60_000;
const SITE_DOWN_RETRIES = 6;

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

/**
 * 広告・ポップアンダー配信網。横取りして落とすのはここだけ。
 *
 * 遮断方針は二度変えている。
 * 1. 当初「同一サイト以外のサブリソースを全部遮断」→ アップローダは自前の JS を別ドメインの
 *    CDN から配る (frdl.hk → cdn.freedl.ink)。止めるとボタンの onclick が未定義になりページが死ぬ。
 * 2. 次に「広告と他所の iframe だけ遮断」→ それでも route('**\/*') で全通信を横取りしていると
 *    Cloudflare Turnstile が自動化とみなして「Verification failed」で弾く。
 * よって今は AD_HOSTS の URL だけを横取りし、人間判定とサイト本体の通信には一切触らない。
 * 偽ボタン対策はドライバ側の要素選択 (data-pd-free のスコアリング) とポップアップ自動クローズが担う。
 */
const AD_HOSTS = [
  'popads.net', 'popcash.net', 'popunder.net', 'propellerads.com', 'propellerpops.com', 'adsterra.com',
  'exoclick.com', 'exosrv.com', 'juicyads.com', 'hilltopads.net', 'clickadu.com', 'adcash.com',
  'onclickads.net', 'onclckds.com', 'adnxs.com', 'doubleclick.net', 'googlesyndication.com',
  'google-analytics.com', 'googletagmanager.com', 'criteo.com', 'taboola.com', 'outbrain.com',
  'mgid.com', 'revcontent.com', 'zedo.com', 'trafficjunky.net', 'a-ads.com', 'adservice.google.com',
];

/**
 * AD_HOSTS (と config の browser.adHosts) だけを横取りするためのパターン。
 * これ以外の通信には一切触らない。
 */
export function adUrlRe(extra: string[] = []): RegExp {
  const hosts = [...new Set([...AD_HOSTS, ...extra.map((h) => h.trim().toLowerCase()).filter(Boolean)])];
  return new RegExp(`^https?://([^/]*\\.)?(${hosts.map((h) => h.replace(/\./g, '\\.')).join('|')})([:/]|$)`, 'i');
}

/**
 * サイトのカウントダウンはウィンドウのフォーカスが外れると止まる作りが多い
 * (uploady は blur と visibilitychange で pauseTimer を呼ぶ)。
 * 自動操作のタブは裏に回っても進んでほしいので、常に「表示中・フォーカスあり」に見せる。
 * ページのスクリプトより先に走るので、capture で止めれば相手のハンドラは動かない。
 */
const KEEP_AWAKE_SCRIPT = `(() => {
  try {
    Object.defineProperty(document, 'hidden', { get: function () { return false; }, configurable: true });
    Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; }, configurable: true });
    Object.defineProperty(document, 'webkitHidden', { get: function () { return false; }, configurable: true });
  } catch (e) { /* ignore */ }
  var swallow = function (e) { e.stopImmediatePropagation(); };
  window.addEventListener('blur', swallow, true);
  document.addEventListener('visibilitychange', swallow, true);
  document.addEventListener('webkitvisibilitychange', swallow, true);
  window.addEventListener('focus', function () { /* keep */ }, true);
})();`;

/** popupGuardScript が握り潰した window.open を知らせる目印 */
const POPUP_BLOCKED_MARK = '__pd_popup_blocked';

/**
 * ポップアンダー広告を「開かせない」。
 *
 * dailyuploads はボタンの onclick が window.open で広告を開き、そのクリックは本来の遷移をしない。
 * 開いてから閉じるのでは画面を数秒奪われるうえ、ドライバから見ると空振りのクリックになる。
 * ここで **他所へ向かう window.open だけ** 握り潰し、サイト自身のウィンドウは通す。
 *
 * 返り値を null にすると `w.document.write(...)` のようなコードが例外で止まり、
 * ページ側の処理が丸ごと死ぬことがある。何をしても無害なダミーを返すこと。
 *
 * KEEP_AWAKE_SCRIPT と同じく、効かせるのは browser.adGuardHosts のサイトだけ
 * (ページ読み込み前のスクリプト差し込みそのものが自動化の痕跡になる)。
 */
export function popupGuardScript(base: string): string {
  return `(() => {
  var BASE = ${JSON.stringify(base)};
  var ours = function (u) {
    try {
      if (!u) return false;
      var h = new URL(String(u), location.href).hostname.toLowerCase();
      return h === BASE || h.endsWith('.' + BASE);
    } catch (e) { return false; }
  };
  var noop = function () {};
  var stub = function () {
    return {
      closed: true, close: noop, focus: noop, blur: noop, postMessage: noop, opener: null,
      document: { write: noop, writeln: noop, open: noop, close: noop },
      location: { href: '', replace: noop, assign: noop, reload: noop },
    };
  };
  var open = window.open;
  try {
    Object.defineProperty(window, 'open', {
      configurable: true,
      value: function (u) {
        if (ours(u)) return open.apply(window, arguments);
        // 握り潰したことをエンジンへ伝える。ドライバはこれを「広告に吸われたクリック」として
        // 数え、押した回数に入れずに押し直す (clickPersistently)
        try { console.warn('${POPUP_BLOCKED_MARK}', String(u || 'about:blank').slice(0, 120)); } catch (e) { /* ignore */ }
        return stub();
      },
    });
  } catch (e) { /* ignore */ }
})();`;
}

/**
 * 画面下の状態バナー。
 *
 * addInitScript で全ページに仕込むのはやめた。CDP 経由でページ読み込み前にスクリプトを
 * 差し込む行為そのものが自動化の痕跡になり、Cloudflare Turnstile に嫌われる。
 * 表示が必要になった時に page.evaluate で描くだけにする (関数ではなく文字列で渡すこと)。
 */
const BANNER_FN = `(function (text, mode) {
  if (window.top !== window) return;
  var b = document.getElementById('__pd_banner');
  if (!b) {
    b = document.createElement('div');
    b.id = '__pd_banner';
    b.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;color:#fff;font:14px/1.4 system-ui,sans-serif;padding:10px 14px;text-align:center;box-shadow:0 -2px 8px rgba(0,0,0,.35);pointer-events:none';
    (document.body || document.documentElement).appendChild(b);
  }
  b.textContent = 'PowerDowner: ' + text;
  b.style.background = mode === 'human' ? '#d97706' : mode === 'manual' ? '#dc2626' : '#374151';
  b.style.fontWeight = mode === 'human' ? '700' : '400';
})`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseDomainOf(hostname: string): string {
  const parts = hostname.toLowerCase().split('.');
  return parts.length <= 2 ? hostname.toLowerCase() : parts.slice(-2).join('.');
}

function pathnameOf(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname); } catch { return url; }
}

/**
 * 広告対策を強めたサイトで、メインフレームのこの遷移を止めるか。
 *
 * 待ち時間の最中に広告がページごと飛ばしてくるのを防ぐためのもの。
 * 直リンクは別ドメインで配られることがあるので、ファイルへ向かう遷移は通す
 * (ここで止めるとダウンロードそのものが始まらない)。
 */
export function blocksNavigation(url: string, bases: Iterable<string>): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  // about:blank / blob: / data: には触らない。ダウンロードの受け皿になっていることがある
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if ([...bases].some((b) => host === b || host.endsWith('.' + b))) return false;
  return !FILE_EXT.test(pathnameOf(url));
}

/** 設定のホスト一覧に当たるか。設定には frdl.hk とも www.frdl.hk とも書かれうる */
export function listedHost(base: string, list: string[]): boolean {
  return list.some((h) => {
    const x = h.trim().toLowerCase();
    return !!x && (base === x || base.endsWith('.' + x) || x.endsWith('.' + base));
  });
}

export class BrowserEngine {
  readonly name = 'browser' as const;
  available = false;
  detail = '未確認';

  private exe: string | null = null;
  private context: BrowserContext | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private waiting: Waiting[] = [];
  /** 進行中のジョブ (jobId → Current)。別サイトなら複数走る */
  private current = new Map<string, Current>();
  /** タブ (ポップアップ含む) がどのジョブのものか。リクエスト遮断と download 検知の帰属に使う */
  private pageOwner = new WeakMap<Page, Current>();
  /** 遮断する広告 URL のパターン。config の browser.adHosts を足して起動時に組み立てる */
  private adRe = adUrlRe();
  private opening = false;
  private nextAgain = false;
  private wakeTimer: NodeJS.Timeout | null = null;

  constructor(private cfg: Config, private cb: BrowserCallbacks) {}

  status(): EngineStatus {
    return { name: 'browser', available: this.available, detail: this.detail };
  }

  async start(): Promise<void> {
    const configured = this.cfg.browser.executablePath;
    const candidates = configured ? [configured, ...EDGE_PATHS] : EDGE_PATHS;
    this.exe = candidates.find((p) => fs.existsSync(p)) ?? null;
    if (!this.exe) {
      this.setStatus(false, 'ブラウザ (Edge / Chrome) が見つかりません。config.json の browser.executablePath で指定してください');
      return;
    }
    this.setStatus(true, `ブラウザ自動操作: ${path.basename(this.exe)}`);
  }

  async stop(): Promise<void> {
    for (const cur of [...this.current.values()]) this.finish(cur);
    try { await this.context?.close(); } catch { /* ignore */ }
    this.context = null;
  }

  private setStatus(available: boolean, detail: string): void {
    const changed = this.available !== available || this.detail !== detail;
    this.available = available;
    this.detail = detail;
    if (changed) {
      log(`[browser] ${detail}`);
      bus.emit('engine', this.status());
    }
  }

  // ---- ジョブ操作 --------------------------------------------------------

  async add(job: Job): Promise<void> {
    if (!this.available) throw new Error(`ブラウザが利用できません: ${this.detail}`);
    // 再起動をまたいでもサイト制限待ちを守る
    const notBefore = typeof job.meta.notBefore === 'number' ? job.meta.notBefore : 0;
    if (notBefore > Date.now()) {
      // 再起動で downloading に戻っているので、待ち状態を理由ごと復元する
      const why = typeof job.meta.waitReason === 'string' && job.meta.waitReason ? job.meta.waitReason : 'サイトの無料ダウンロード間隔';
      if (this.cb.onSiteWait(job.id, notBefore, why)) return; // 別の候補へ移された
    }
    this.waiting.push({ job, base: baseDomainOf(new URL(job.url).hostname), notBefore, attempts: 0 });
    await this.next();
  }

  async cancel(job: Job): Promise<void> {
    this.waiting = this.waiting.filter((w) => w.job.id !== job.id);
    const cur = this.current.get(job.id);
    if (cur) this.finish(cur);
  }

  private get slots(): number {
    return Math.max(1, this.cfg.browser.maxConcurrent);
  }

  private busyBases(): Set<string> {
    return new Set([...this.current.values()].map((c) => c.base));
  }

  /**
   * 空いている枠に、待ち行列から実行できるジョブを詰められるだけ詰める。
   * 実行できる = 時間制限が明けていて、かつ同じサイトの処理が走っていない。
   */
  private async next(): Promise<void> {
    // open() は await を挟むので、同期的なフラグが無いと同じジョブを 2 回開いてしまう
    if (this.opening) { this.nextAgain = true; return; }
    this.opening = true;
    try {
      do {
        this.nextAgain = false;
        while (this.current.size < this.slots) {
          const now = Date.now();
          const busy = this.busyBases();
          const w = this.waiting.find((x) => x.notBefore <= now && !busy.has(x.base));
          if (!w) break;
          this.waiting.splice(this.waiting.indexOf(w), 1);
          await this.open(w.job, w.base, w.attempts);
        }
      } while (this.nextAgain);
    } finally {
      this.opening = false;
    }
    this.scheduleWake();
    this.reportWaiting();
  }

  /** サイト制限待ちのジョブがあれば、明ける時刻に自分で起きる */
  private scheduleWake(): void {
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null; }
    const now = Date.now();
    const future = this.waiting.filter((w) => w.notBefore > now).map((w) => w.notBefore);
    if (future.length === 0) return;
    this.wakeTimer = setTimeout(() => { this.next().catch(() => { /* ignore */ }); }, Math.max(1000, Math.min(...future) - now));
  }

  /** 待たされているジョブに、何を待っているのかを表示する */
  private reportWaiting(): void {
    const busy = this.busyBases();
    const now = Date.now();
    for (const w of this.waiting) {
      if (w.notBefore > now) continue; // 制限待ちは onSiteWait 側が時刻を出している
      const detail = busy.has(w.base)
        ? `順番待ち: ${w.base} は同時に 1 件ずつ処理します`
        : `順番待ち: ブラウザの同時処理が上限です (${this.slots} 件)`;
      this.cb.onProgress(w.job.id, { bytesTotal: 0, bytesDone: 0, speed: 0, detail });
    }
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const { chromium } = await import('playwright-core');
      const profileDir = this.cfg.browser.profileDir;
      fs.mkdirSync(profileDir, { recursive: true });
      const ctx = await chromium.launchPersistentContext(profileDir, {
        executablePath: this.exe!,
        headless: false,
        viewport: null,
        acceptDownloads: true,
        // サイトの表示言語を英語に固定する。待ち時間やエラー文言の解析を 1 言語に絞るため。
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        args: [
          '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
          // 裏に回ったタブでもカウントダウンを進めるため、タイマーの間引きを止める
          '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      });
      // 広告配信網の URL だけを横取りする。'**/*' で全部横取りすると Cloudflare Turnstile が
      // 自動化とみなして「Verification failed」になるので、人間判定とサイト本体の通信には触らない。
      this.adRe = adUrlRe(this.cfg.browser.adHosts ?? []);
      await ctx.route(this.adRe, (route) => {
        const req = route.request();
        let owner: Current | undefined;
        try { owner = this.pageOwner.get(req.frame().page()); } catch { /* frame を持たない要求 */ }
        if (owner && owner.blocked.length < 200) owner.blocked.push(`${req.resourceType()} ${req.url().slice(0, 200)}`);
        // 'aborted' (net::ERR_ABORTED) で落とすこと。既定の 'failed' はページ遷移だった場合に
        // 「このページに到達できません」を描いてしまい、待っていたページごと失われる
        return route.abort('aborted');
      });
      ctx.on('page', (p) => this.attachPage(p));
      for (const p of ctx.pages()) this.attachPage(p);
      ctx.on('close', () => {
        this.context = null;
        for (const cur of [...this.current.values()]) {
          const dead = !cur.handled;
          this.finish(cur);
          if (dead) this.cb.onFailed(cur.job.id, 'ブラウザが閉じられました');
        }
        this.next().catch(() => { /* ignore */ });
      });
      this.context = ctx;
      log('[browser] 起動しました');
      return ctx;
    })().finally(() => { this.launching = null; });
    return this.launching;
  }

  private attachPage(page: Page): void {
    page.on('download', (d) => { this.onDownload(page, d).catch((e) => log(`[browser] download handler: ${(e as Error).message}`)); });
    // ポップアップ: 開いた元のジョブと無関係なサイトなら閉じる
    page.opener().then((opener) => {
      if (!opener) return;
      const owner = this.pageOwner.get(opener);
      if (owner) {
        this.pageOwner.set(page, owner);
        // 中身が何であれ「クリックがポップアップに化けた」ことは記録する。
        // ドライバはこの数の増加を見て、空振りのクリックを押し直す。
        owner.popups++;
      }
      // 一度「閉じた」「これは残す」と決めたら、以降は判定しない
      let settled = false;
      const close = (why: string) => {
        if (settled || page.isClosed()) return;
        settled = true;
        log(`[browser] ポップアップを閉じました: ${why}`);
        page.close().catch(() => { /* ignore */ });
        // 閉じるとフォーカスがどこへ行くか分からない。操作中のページを前面に戻す。
        if (owner && !owner.handled) owner.page.bringToFront().catch(() => { /* ignore */ });
      };
      const check = () => {
        if (settled || page.isClosed()) return;
        const u = page.url();
        if (!u || u === 'about:blank') return;   // 行き先がまだ決まっていない
        // 新しいタブでダウンロードを始めるサイトがある。閉じると download の受け皿ごと消える
        if (owner?.downloadSeen || FILE_EXT.test(pathnameOf(u))) { settled = true; return; }
        const bases = owner ? [...owner.bases] : [];
        let host = '';
        try { host = new URL(u).hostname.toLowerCase(); } catch { return; }
        if (bases.some((b) => host === b || host.endsWith('.' + b))) { settled = true; return; }
        close(u.slice(0, 100));
      };
      // 行き先が決まった瞬間に閉じる。時間で見張るだけだと、その間ずっと画面を奪われたままになる
      page.on('framenavigated', (f) => { if (f === page.mainFrame()) check(); });
      check();
      // about:blank のまま居座るポップアンダーもいる。ダウンロードの受け皿である可能性が
      // 消える程度には待ってから閉じる。
      setTimeout(() => {
        if (settled || page.isClosed()) return;
        if (owner?.downloadSeen) { settled = true; return; }
        if (page.url() === 'about:blank') close('about:blank のまま開かれた広告タブ');
      }, 1500);
      setTimeout(check, 4000);
    }).catch(() => { /* ignore */ });
  }

  private async open(job: Job, base: string, attempts: number): Promise<void> {
    try {
      const ctx = await this.ensureContext();
      const page = await ctx.newPage();
      const guard = listedHost(base, this.cfg.browser.adGuardHosts ?? []);
      const cur: Current = { job, base, bases: new Set([base]), page, timer: null as unknown as NodeJS.Timeout, handled: false, downloadSeen: false, attempts, blocked: [], console: [], popups: 0, guard, recoveries: 0 };
      const note = (s: string) => { if (cur.console.length < 300) cur.console.push(`${new Date().toISOString().slice(11, 19)} ${s}`); };
      page.on('console', (m) => {
        const text = m.text();
        // 握り潰した window.open も「クリックが広告に吸われた」1 回として数える。
        // ドライバはこの増加を見て、押した回数に入れずに押し直す (clickPersistently)
        if (text.includes(POPUP_BLOCKED_MARK)) cur.popups++;
        note(`${m.type()}: ${text.slice(0, 300)}`);
      });
      page.on('pageerror', (e) => note(`pageerror: ${e.message.split('\n')[0].slice(0, 300)}`));
      // 可視状態の偽装は人間判定に嫌われる (Turnstile が Verification failed になる)。
      // カウントダウンを自前で止めるサイトにだけ効かせる。他はブラウザ起動フラグ側で足りる。
      if (listedHost(base, this.cfg.browser.keepAwakeHosts ?? [])) {
        await page.addInitScript(KEEP_AWAKE_SCRIPT).catch(() => { /* ignore */ });
      }
      if (guard) {
        // ポップアンダーは「閉じる」より「開かせない」。閉じるだけでは画面を数秒奪われる
        await page.addInitScript(popupGuardScript(base)).catch(() => { /* ignore */ });
        // 待ち時間の最中に広告がページごと他所へ飛ばしてくる。飛ばされてから戻ったのでは
        // カウントダウンが振り出しに戻るので、メインフレームの遷移そのものを止める。
        // 止められた遷移は現在のページを壊さない (net::ERR_ABORTED) ので、秒数は進み続ける。
        await page.route('**/*', (route) => this.guardNavigation(cur, route)).catch(() => { /* ignore */ });
        log(`[browser] ${job.id}: ${base} は広告対策を強めて開きます`);
      }
      page.on('framenavigated', (f) => {
        if (f !== page.mainFrame()) return;
        const u = f.url();
        let b = '';
        try { b = baseDomainOf(new URL(u).hostname); } catch { return; }   // about:blank など
        if (cur.bases.has(b)) return;
        // 広告配信網は「サイトの続き」ではない。足すと、そこが開くポップアップまで
        // 自分のサイト扱いになって閉じられなくなる
        if (this.adRe.test(u)) { this.backToJob(cur, u); return; }
        // 止めそこねた遷移 (エラーページへの着地を含む)。待っていたページへ戻す
        if (guard && blocksNavigation(u, cur.bases)) { this.backToJob(cur, u); return; }
        cur.bases.add(b);
        log(`[browser] ${job.id}: ${base} → ${b} へ移動したので同一サイト扱いに追加`);
      });
      cur.timer = setTimeout(() => {
        if (!cur.handled) this.fail(job.id, `ブラウザ操作が ${this.cfg.browser.timeoutMinutes} 分以内に完了しなかったため中断しました`);
      }, this.cfg.browser.timeoutMinutes * 60_000);
      this.current.set(job.id, cur);
      this.pageOwner.set(page, cur);
      // 起動直後の空タブだけ掃除する。他ジョブのタブは持ち主が付いているので触らない
      for (const p of ctx.pages()) if (!this.pageOwner.has(p) && p.url() === 'about:blank') p.close().catch(() => { /* ignore */ });
      page.on('crash', () => log(`[browser] ${job.id}: タブがクラッシュしました (${page.url().slice(0, 120)})`));
      page.on('close', () => {
        // サイト側が window.close() する / 落ちるケースがあるので、最後に居た URL を残す
        if (!cur.handled) this.fail(job.id, `ブラウザのタブが閉じられました (最後の URL: ${page.url().slice(0, 200) || '不明'})`);
      });
      this.cb.onProgress(job.id, { bytesTotal: 0, bytesDone: 0, speed: 0, detail: '自動操作中: ページを開いています' });
      const res = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch((e) => { log(`[browser] goto: ${(e as Error).message}`); return null; });
      // Cloudflare の 5xx (522 Connection timed out など) はサイトの向こう側が落ちている。
      // 人間にもどうにもならないので、手動モードに落とさず時間を置いて自分で試し直す。
      const code = res?.status() ?? 0;
      if (code >= 500) { this.retryLater(cur, `サイト側が応答しません (HTTP ${code})`); return; }
      // ドライバは長時間走るので待たない。枠は this.current に確保済み。
      this.runDriver(cur).catch((e) => {
        if (!cur.handled) this.fail(job.id, `自動操作でエラー: ${(e as Error).message.split('\n')[0]}`);
      });
    } catch (e) {
      this.fail(job.id, `ブラウザを起動できません: ${(e as Error).message}`);
    }
  }

  /**
   * 広告のページに着地してしまったときに、待っていたページへ戻す。
   *
   * 本筋は guardNavigation で遷移を止めること (戻るとカウントダウンが振り出しに戻るため)。
   * これは止めそこねた時の保険なので、繰り返さずに諦める。
   */
  private backToJob(cur: Current, url: string): void {
    if (cur.handled || cur.page.isClosed() || cur.recoveries >= 3) return;
    cur.recoveries++;
    log(`[browser] ${cur.job.id}: 広告のページへ着地したので戻ります (${url.slice(0, 120)})`);
    void (async () => {
      const back = await cur.page.goBack({ timeout: 15_000 }).catch(() => null);
      if (back || cur.handled || cur.page.isClosed()) return;
      // 広告が履歴を汚していて戻れない。最初のページからやり直す
      await cur.page.goto(cur.job.url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(() => { /* ドライバが次の巡回で気づく */ });
    })();
  }

  /**
   * 広告によるページ遷移を止める (browser.adGuardHosts のサイトだけ)。
   *
   * 見るのは**メインフレームの遷移だけ**。サブリソースと iframe には触らない
   * (全通信に手を入れると自動化の signature になる。それが許されるのは
   * 人間判定の緩いサイトに限る、というのが adGuardHosts の意味)。
   *
   * 自分で処理しないときは `continue()` ではなく `fallback()` を使うこと。
   * `continue()` はページ側の route で打ち止めになり、コンテキスト側に仕掛けた
   * 広告配信網の遮断 (AD_HOSTS) をすり抜けてしまう。
   *
   * 止めるときは **`abort('aborted')`** を使うこと。既定の `abort()` は `net::ERR_FAILED` で、
   * Chromium がその URL のままエラーページ (「このページに到達できません」) を描いてしまい、
   * 待っていたページごと失われる。`net::ERR_ABORTED` だけが「無かったこと」にできる。
   */
  private guardNavigation(cur: Current, route: Route): void {
    const req = route.request();
    if (!req.isNavigationRequest() || req.frame() !== cur.page.mainFrame()) { void route.fallback(); return; }
    const url = req.url();
    if (!blocksNavigation(url, cur.bases)) { void route.fallback(); return; }
    if (cur.blocked.length < 200) cur.blocked.push(`navigation ${url.slice(0, 200)}`);
    log(`[browser] ${cur.job.id}: 広告のページ遷移を止めました (${url.slice(0, 120)})`);
    void route.abort('aborted');
  }

  private async runDriver(cur: Current): Promise<void> {
    const { job, page } = cur;
    if (job.meta.browserDirect === true) {
      // ブラウザ自身に保存させるモードでも、操作は自動で進める (download イベントで saveAs する)
    }
    const ctx: DriverContext = {
      page,
      url: job.url,
      // 直リンクの判定にも使うので、投入時の URL ではなく「いま居るページ」のドメインを返す
      get baseDomain(): string {
        try { return baseDomainOf(new URL(page.url()).hostname); } catch { return cur.base; }
      },
      setStatus: (detail) => {
        if (cur.handled) return;
        this.cb.onProgress(job.id, { bytesTotal: 0, bytesDone: 0, speed: 0, detail });
        this.banner(page, detail, 'auto');
      },
      askHuman: (message) => {
        if (cur.handled) return;
        this.cb.onWaitingHuman(job.id, true, message);
        this.banner(page, message, 'human');
        toast('PowerDowner: あなたの番です', `${job.filename ?? job.url}\n${message}`, `human:${job.id}`);
        page.bringToFront().catch(() => { /* ignore */ });
      },
      humanDone: () => {
        if (cur.handled) return;
        this.cb.onWaitingHuman(job.id, false, '');
        this.banner(page, '自動操作中: ありがとうございます、続きは自動です', 'auto');
      },
      downloadDetected: () => cur.downloadSeen,
      popupCount: () => cur.popups,
      focus: () => { page.bringToFront().catch(() => { /* ignore */ }); },
      log: (m) => log(`[browser] ${job.id}: ${m}`),
    };

    // ドライバが対応するページか判定する。
    // turbobit のような SPA は描画に 10 秒近くかかるので、すぐには諦めない。
    let driveable = false;
    const gateUntil = Date.now() + 20_000;
    while (Date.now() < gateUntil) {
      await sleep(1000);
      if (cur.downloadSeen) return; // 直リンクなどは download イベントが先に来る
      if (cur.handled) return;
      const snap = await snapshot(page).catch(() => null);
      if (snap && isXfsLikely(snap)) { driveable = true; break; }
    }
    if (!driveable) {
      if (cur.handled) return;
      await this.manual(cur, '自動操作に対応していないページです');
      return;
    }

    let result;
    try {
      result = await drive(ctx);
    } catch (e) {
      if (cur.handled) return;
      result = { kind: 'manual' as const, reason: `自動操作でエラー: ${(e as Error).message.split('\n')[0]}` };
    }
    if (cur.handled && result.kind !== 'download-started') return;

    switch (result.kind) {
      case 'download-started':
        return; // onDownload が処理済み
      case 'direct':
        await this.handoffUrl(cur, page, result.url, result.filename);
        return;
      case 'wait': {
        const resumeAt = Date.now() + result.ms + 15_000;
        log(`[browser] ${job.id}: 制限待ち ${Math.round(result.ms / 60000)} 分 (${result.reason})`);
        this.finish(cur);
        if (this.cb.onSiteWait(job.id, resumeAt, result.reason)) return; // 別の候補へ移された
        this.waiting.push({ job: { ...job, meta: { ...job.meta, notBefore: resumeAt } }, base: cur.base, notBefore: resumeAt, attempts: 0 });
        this.next().catch(() => { /* ignore */ });
        return;
      }
      case 'failed':
        this.fail(job.id, result.reason);
        return;
      case 'manual':
        await this.manual(cur, result.reason);
        return;
    }
  }

  /** サイトが落ちているだけなら、時間を置いて自分で試し直す (人間を呼ばない) */
  private retryLater(cur: Current, reason: string): void {
    const tries = cur.attempts + 1;
    if (tries > SITE_DOWN_RETRIES) {
      this.fail(cur.job.id, `${reason}。${SITE_DOWN_RETRIES} 回試しても復旧しませんでした`);
      return;
    }
    const resumeAt = Date.now() + SITE_DOWN_WAIT;
    log(`[browser] ${cur.job.id}: ${reason} → ${SITE_DOWN_WAIT / 60_000} 分後に再試行 (${tries}/${SITE_DOWN_RETRIES})`);
    this.finish(cur);
    if (this.cb.onSiteWait(cur.job.id, resumeAt, reason)) return; // 別の候補へ移された
    this.waiting.push({
      job: { ...cur.job, meta: { ...cur.job.meta, notBefore: resumeAt } },
      base: cur.base, notBefore: resumeAt, attempts: tries,
    });
    this.next().catch(() => { /* ignore */ });
  }

  private async manual(cur: Current, reason: string): Promise<void> {
    await this.debugDump(cur, reason);
    const msg = `${reason}。手動で進めてください: ダウンロードが始まれば自動で引き継ぎます`;
    log(`[browser] ${cur.job.id}: 手動モード (${reason})`);
    this.cb.onWaitingHuman(cur.job.id, true, msg);
    this.banner(cur.page, msg, 'manual');
    toast('PowerDowner: 手動操作が必要です', `${cur.job.filename ?? cur.job.url}\n${reason}`, `manual:${cur.job.id}`);
    cur.page.bringToFront().catch(() => { /* ignore */ });
  }

  /** いま開いているページを調べる。ページが動かないときはまずこれを見る */
  async dump(jobId: string, shot = true): Promise<{ url: string; files: string; blocked: string[]; console: string[] } | null> {
    const cur = this.current.get(jobId);
    if (!cur) return null;
    // shot=false ならページに触らない (人間判定の最中はスクリーンショットも取らない)
    const base = shot ? await this.debugDump(cur, '手動ダンプ') : '';
    return { url: cur.page.url(), files: base ? `${base}.html / .png` : '(取得せず)', blocked: [...cur.blocked], console: [...cur.console] };
  }

  private async debugDump(cur: Current, reason: string): Promise<string> {
    let base = '';
    try {
      const dir = path.join(this.cfg.dataDir, 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      base = path.join(dir, `${cur.job.id}-${stamp}`);
      const html = await cur.page.content();
      const note = [`<!-- ${cur.page.url()} | ${reason}`, ...cur.blocked.map((b) => `  遮断: ${b}`), '-->'].join('\n');
      fs.writeFileSync(`${base}.html`, `${note}\n${html}`);
      await cur.page.screenshot({ path: `${base}.png` }).catch(() => { /* ignore */ });
      log(`[browser] ${cur.job.id}: デバッグ保存 ${base}.html (遮断 ${cur.blocked.length} 件)`);
    } catch (e) {
      log(`[browser] debug dump failed: ${(e as Error).message}`);
    }
    return base;
  }

  private banner(page: Page, text: string, mode: 'auto' | 'human' | 'manual'): void {
    // 関数ではなく文字列で渡す (tsx の keepNames が __name を埋め込んでブラウザ側で落ちるため)
    page.evaluate(`${BANNER_FN}(${JSON.stringify(text)}, ${JSON.stringify(mode)})`)
      .catch(() => { /* ページ遷移中などは無視 */ });
  }

  private async waitDownload(cur: Current, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (cur.downloadSeen) return true;
      await sleep(250);
    }
    return cur.downloadSeen;
  }

  private async onDownload(page: Page, download: Download): Promise<void> {
    const cur = this.pageOwner.get(page);
    if (!cur || cur.handled) {
      await download.cancel().catch(() => { /* ignore */ });
      return;
    }
    cur.downloadSeen = true;
    cur.handled = true;
    const url = download.url();
    const suggested = download.suggestedFilename();
    log(`[browser] ${cur.job.id}: ダウンロード検知 ${suggested} <- ${url.slice(0, 120)}`);

    if (cur.job.meta.browserDirect === true) {
      await this.saveViaBrowser(cur, download, suggested);
      return;
    }
    await download.cancel().catch(() => { /* ignore */ });
    await this.handoffUrl(cur, page, url, suggested || undefined, true);
  }

  /** 直リンクを Cookie / UA / Referer 付きで aria2 へ渡す */
  private async handoffUrl(cur: Current, page: Page, url: string, filename?: string, alreadyHandled = false): Promise<void> {
    if (!alreadyHandled && cur.handled) return;
    cur.handled = true;
    try {
      const ctx = page.context();
      const cookies = await ctx.cookies(url);
      const ua = await page.evaluate(() => navigator.userAgent).catch(() => '');
      const referer = page.url();
      const headers: string[] = [];
      if (cookies.length) headers.push('Cookie: ' + cookies.map((c) => `${c.name}=${c.value}`).join('; '));
      const options: Record<string, string> = { split: '1', 'max-connection-per-server': '1' };
      if (ua) options['user-agent'] = ua;
      if (referer && !referer.startsWith('about:')) options.referer = referer;
      this.finish(cur);
      this.cb.onHandoff(cur.job.id, { url, filename, headers, options });
    } catch (e) {
      this.finish(cur);
      this.cb.onFailed(cur.job.id, `引き継ぎに失敗しました: ${(e as Error).message}`);
    }
  }

  private async saveViaBrowser(cur: Current, download: Download, suggested: string): Promise<void> {
    const name = suggested || `download-${cur.job.id}`;
    const dest = path.join(cur.job.destDir, name);
    this.cb.onWaitingHuman(cur.job.id, false, '');
    this.cb.onProgress(cur.job.id, { bytesTotal: 0, bytesDone: 0, speed: 0, filename: name, detail: 'ブラウザがダウンロード中 (進捗は表示できません)' });
    try {
      await download.saveAs(dest);
      const failure = await download.failure();
      if (failure) throw new Error(failure);
      const size = fs.statSync(dest).size;
      this.cb.onProgress(cur.job.id, { bytesTotal: size, bytesDone: size, speed: 0, filename: name });
      this.cb.onDone(cur.job.id, name);
    } catch (e) {
      this.cb.onFailed(cur.job.id, `ブラウザでのダウンロードに失敗しました: ${(e as Error).message}`);
    } finally {
      this.finish(cur);
    }
  }

  private fail(jobId: string, message: string): void {
    const cur = this.current.get(jobId);
    if (cur) this.finish(cur);
    this.cb.onFailed(jobId, message);
  }

  /** ジョブの後始末: タイマー解除、タブを閉じ、空いた枠に次のジョブを入れる */
  private finish(cur: Current): void {
    clearTimeout(cur.timer);
    cur.handled = true; // タブを閉じる際の close イベントで失敗扱いにしないため
    if (this.current.get(cur.job.id) === cur) this.current.delete(cur.job.id);
    cur.page.close().catch(() => { /* ignore */ });
    setTimeout(() => { this.next().catch(() => { /* ignore */ }); }, 500);
  }
}
