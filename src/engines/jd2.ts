import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../config.js';
import type { Job, EngineStatus } from '../types.js';
import { bus, log } from '../events.js';
import type { EngineCallbacks } from './aria2.js';
import { uniqueName } from '../naming.js';

/**
 * JDownloader 2 の "Deprecated API" (既定 http://127.0.0.1:3128) クライアント。
 *
 * 呼び出し形式 (実機確認済み):
 *   GET /<namespace>/<method>?<param1>&<param2>...   各 param は JSON を URL エンコードしたもの
 *   応答は {"data": ...}。エラーは {"src":"DEVICE","data":"/path","type":"BAD_PARAMETERS"}。
 *   POST の JSON 配列はサーバー側で例外になるので使わない。
 *
 * ジョブの対応付け:
 *   パッケージ名は JD2 側のルール (書庫名など) で書き換えられるため当てにしない。
 *   addLinks が返すクロールジョブ ID でリンクを拾い、リンク UUID (LinkGrabber → ダウンロード一覧で不変) で追跡する。
 *   LinkGrabber 上で movetoNewPackage して名前と保存先を強制してから、ダウンロード一覧へ移す。
 */

export interface Jd2Callbacks extends EngineCallbacks {
  onWaitingHuman(jobId: string, waiting: boolean, detail: string): void;
  /** 追跡中のリンク UUID を永続化してもらう (再起動後の復元用) */
  onLinkIds(jobId: string, linkIds: number[]): void;
  /** JD2 が扱えない人間判定でスキップされた。ブラウザ引き継ぎへ回してほしい */
  onNeedsBrowser(jobId: string, reason: string): void;
  /**
   * 今のアップローダが同時ダウンロード数の上限で待たされている。
   * 空いている別のアップローダがあれば、そちらへ回してほしい。
   */
  onHostLimited(jobId: string, reason: string): void;
}

interface Jd2Link {
  uuid: number;
  packageUUID?: number;
  name?: string;
  host?: string;
  url?: string;
  availability?: 'ONLINE' | 'OFFLINE' | 'UNKNOWN' | 'TEMP_UNKNOWN';
  bytesTotal?: number;
  bytesLoaded?: number;
  speed?: number;
  status?: string;
  finished?: boolean;
  skipped?: boolean;
  running?: boolean;
  enabled?: boolean;
}

interface Jd2CrawlerJob {
  jobId: number;
  crawling?: boolean;
  checking?: boolean;
  crawled?: number;
  filtered?: number;
  broken?: number;
  unhandled?: number;
}

interface Jd2Captcha {
  id: number;
  hoster?: string;
  captchaCategory?: string;
  challengeType?: string;
  type?: string;
  explain?: string;
  created?: number;
  timeout?: number;
  link?: number;
}

/**
 * JD2 のローカルダイアログでは解けない CAPTCHA の種類。
 * hCaptcha / reCAPTCHA / Turnstile は正しいオリジンで動かす必要があり、JD2 は
 * 127.0.0.1 のページ + ブラウザ拡張で解決させる方式を取る。その拡張はもう配布されて
 * いないため、これらは自前のブラウザ経路 (実サイト上で人間がチェックを押す) に回す。
 */
const BROWSER_SOLVER = /hcaptcha|recaptcha|turnstile|cloudflare|geetest|funcaptcha|arkose/i;

function needsBrowserSolver(c: Jd2Captcha): boolean {
  return BROWSER_SOLVER.test(`${c.type ?? ''} ${c.challengeType ?? ''} ${c.captchaCategory ?? ''} ${c.explain ?? ''}`);
}

interface Tracked {
  job: Job;
  phase: 'crawl' | 'download';
  crawlJobId: number | null;
  linkIds: number[];
  addedAt: number;
  movedAt: number;
  humanWaiting: boolean;
  sawCaptcha: boolean;        // JD2 が解ける種類の CAPTCHA (ダイアログ) を一度でも出したか
  captchaErrorSince: number;  // CAPTCHA 系のエラーで進まなくなった時刻 (0 なら正常)
  limitedSince: number;       // ホストの同時ダウンロード上限で待たされ始めた時刻 (0 なら正常)
  limitReported: boolean;     // 切り替えを 1 度だけ頼む。poll のたびに投げない
}

/**
 * 「今は落とせない、待て」とアップローダが言っている状態。
 *
 * JD2 はこれを失敗にせず、待ちのまま止め続ける。放っておくと 0 B/s のカードが
 * 並んだままになるので、こちらから見切って別のホストへ回す。
 *
 * status 文字列は JD2 の言語設定でローカライズされる。実機 (日本語) では
 * 「1m:32s 待機」のような残り時間表示、英語では
 * 「Download limit reached or wait until next download can be started」になる。
 *
 * 短い待ち (再接続の数秒待ちなど) まで拾ってしまうが、切り替えるのは
 * この状態が hostLimitWaitSec の間続いた時だけなので、そこで振り落とされる。
 * 当たらない言語では何もしない — 誤検知で実績のあるホストを手放すほうが痛いので、
 * 拾えないぶんは黙って従来どおり待つほうを選ぶ。
 */
export const HOST_LIMIT = new RegExp(
  [
    'download limit', 'limit reached', 'wait until next download',
    'too many (?:simultaneous |parallel )?download', 'simultaneous download',
    'ダウンロード制限', '同時ダウンロード',
    // 「34s 待機」「1m:32s 待機」— 日本語 JD2 の待ち時間表示
    '待機', '待って',
  ].join('|'),
  'i'
);

/**
 * 人間判定ではないスキップ。JD2 はこれらも CAPTCHA と同じ「スキップ」で返すので、
 * 見分けずにブラウザ経路へ回すと、JD2 なら素通りできるサイト (dailyuploads) を
 * ブラウザが不慣れな手つきで踏みに行って詰まる。ブラウザに回しても直らないので失敗にする。
 *
 * status 文字列はローカライズされている。日本語は JD2 同梱の
 * translations/.../JdownloaderTranslation.ja.lng (DownloadLink_setSkipped_statusmessage_*) から。
 * 当たらない言語では従来どおりブラウザへ回るだけなので、取りこぼしても悪化はしない。
 */
export const SKIP_NOT_HUMAN = new RegExp(
  [
    'ファイル既存', 'file (?:already )?exists',
    'ダウンロードディレクトリ', 'download (?:directory|folder)', 'invalid (?:path|destination)',
    '空き容量', 'disk (?:is )?full',
    '再試行過多', 'too many retries',
    'ffmpeg', 'ffprobe', 'phantomjs',
    '利用可能な接続無し', 'no connection',
  ].join('|'),
  'i'
);

/**
 * `\\NAS\share\...` か。JD2 は保存前に親フォルダを共有のルートまで遡って作ろうとし、
 * `not allowed to create path \\192.168.3.30\disk1_pt1` で INVALID_DESTINATION になる
 * (2026-09-24 に JD2 のログで確認)。aria2 と Node は書けるので、JD2 だけ手元で受ける。
 */
export function isUnc(dir: string): boolean {
  return /^[\\/]{2}[^\\/]/.test(dir);
}

/** JD2 の標準出力から拾う価値のある行。これ以外は数が多すぎて読めない */
const JD2_NOTEWORTHY = /error|exception|fatal|severe|failed|refused/i;
/**
 * headless 起動では毎回出るが、手当ての要らないもの。スタックトレースが並ぶと本物の異常が
 * 埋もれるので、意味の分かる 1 行に置き換えて起動ごとに 1 回だけ出す。
 * - No Console Available: 画面も端末も無いので JD2 の対話コンソール UI は初期化できない。
 *   PowerDowner は人間が要る場面を全部ブラウザ経路に回すので、これで困らない
 */
const JD2_BENIGN: Array<[RegExp, string]> = [
  [/No Console Available/i, 'headless なので JD2 の対話コンソールは初期化されません (想定どおり)'],
  [/UpdateManager|updatesys\.client/i, 'JD2 の自動アップデート確認に失敗しました (JD2 が後で再試行します)'],
];
const RELAY_LIMIT = 50;

const CRAWL_IDLE_MS = 20_000;     // クロール終了後これだけ待ってもリンクが無ければ諦める
const CRAWL_GRACE_MS = 180_000;   // クロール自体の上限
const AVAIL_WAIT_MS = 60_000;     // オンライン確認の上限
const MOVED_GRACE_MS = 30_000;    // ダウンロード一覧に現れるまでの猶予

export class Jd2Engine {
  readonly name = 'jd2' as const;
  available = false;
  detail = '未接続';
  /**
   * JD2 が GUI 無しで動いているか。true の間は CAPTCHA ダイアログを出す先が無いので、
   * 人間待ちになりそうなものは種類を問わずブラウザ経路へ回す。
   */
  headless = false;

  private tracked = new Map<string, Tracked>();
  private timers: NodeJS.Timeout[] = [];
  private lastCaptchaKey = '';
  private polling = false;
  private proc: ChildProcess | null = null;
  private launched = false;   // この PowerDowner が JD2 を起動したか
  private launching = false;
  private lastLaunchAt = 0;
  private stopping = false;

  constructor(private cfg: Config, private cb: Jd2Callbacks) {}

  status(): EngineStatus {
    return { name: 'jd2', available: this.available, detail: this.detail };
  }

  async start(): Promise<void> {
    await this.check();
    // 既に動いていればそれを使う。JD2 は JD2.lock で二重起動を弾くので、前回ハードキル
    // されて取り残された JD2 も、ここで引き継いだ上で終了時に始末できる。
    if (this.available) {
      await this.detectHeadless();
      await this.check();   // headless が分かってから状態表示を作り直す
    } else {
      await this.ensureRunning();
    }
    // 死活監視のついでに、落ちていたら起こし直す。画面が無いので放っておくと
    // 「JD2 担当のホスターだけ静かに失敗し続ける」状態に気づけない。
    this.timers.push(setInterval(() => {
      this.check().then(() => this.ensureRunning()).catch(() => { /* ignore */ });
    }, 15_000));
    this.timers.push(setInterval(() => {
      if (this.polling) return;
      this.polling = true;
      this.poll().catch((e) => log(`[jd2] poll error: ${(e as Error).message}`)).finally(() => { this.polling = false; });
    }, 2_000));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
    // JD2 の面倒を PowerDowner が見ている時だけ落とす。headless の JD2 は画面もトレイも
    // 無いので、残ると誰にも気づかれないまま居座る。ここは確実に始末する。
    if (!this.cfg.jd2.autoStart || !this.cfg.jd2.stopOnExit) return;
    await this.shutdownJd2();
  }

  private setStatus(available: boolean, detail: string): void {
    const changed = this.available !== available || this.detail !== detail;
    this.available = available;
    this.detail = detail;
    if (changed) {
      log(`[jd2] ${detail}`);
      bus.emit('engine', this.status());
    }
  }

  private async check(): Promise<void> {
    try {
      const v = await this.api<unknown>('/jd/version');
      this.setStatus(true, `JD2 接続中 (build ${String(v)}${this.headless ? ', headless' : ''})`);
    } catch {
      const hint = this.cfg.jd2.autoStart ? '自動起動を待っています' : 'JD2 を起動し Deprecated API を有効にしてください';
      this.setStatus(false, `JD2 に接続できません (${this.cfg.jd2.apiUrl})。${hint}`);
    }
  }

  // ---- プロセスの面倒を見る ----------------------------------------------

  /** 落ちていれば起こす。立て続けの再起動でループにならないよう最低 60 秒は空ける */
  private async ensureRunning(): Promise<void> {
    if (this.available || this.stopping || this.launching) return;
    if (!this.cfg.jd2.autoStart) return;
    if (Date.now() - this.lastLaunchAt < 60_000) return;
    this.launching = true;
    this.lastLaunchAt = Date.now();
    try {
      await this.launch();
    } catch (e) {
      log(`[jd2] 自動起動に失敗: ${(e as Error).message}`);
    } finally {
      this.launching = false;
    }
  }

  /**
   * API も返さないのに生き残っている JD2 を止める。Windows では PowerDowner に SIGTERM が
   * 届かない (taskkill /F でしか落ちない) ので、LocalLauncher に止められた後は終了処理が
   * 走らず JD2 が取り残される。その JD2 が JD2.lock を握ったままだと次の起動も失敗し、
   * 画面が無いので誰も気づけない。ここで自己修復しておく。
   *
   * PID は使い回されるので、コマンドラインに JDownloader.jar が入っていることを
   * 確かめてからでないと止めない (この PC には無関係な java が常駐している)。
   */
  private async killStale(): Promise<void> {
    const file = path.join(this.cfg.dataDir, 'jd2.pid');
    let pid = 0;
    try { pid = Number(fs.readFileSync(file, 'utf8').trim()); } catch { return; }
    if (!Number.isInteger(pid) || pid <= 0) { this.clearPid(); return; }
    if (!(await isJd2Process(pid))) { this.clearPid(); return; }
    log(`[jd2] 応答しない JD2 (PID ${pid}) が残っているので止めます`);
    try { process.kill(pid); } catch { /* もう居ない */ }
    await sleep(2000);
    this.clearPid();
  }

  /** JD2 を自分で起動する。初回は自動アップデートが走るので気長に待つ */
  private async launch(): Promise<void> {
    await this.killStale();
    const j = this.cfg.jd2;
    const jar = path.join(j.dir, 'JDownloader.jar');
    if (!fs.existsSync(jar)) {
      this.setStatus(false, `JDownloader.jar がありません (${jar})。scripts/fetch-tools.ps1 を実行してください`);
      return;
    }
    const java = this.resolveJava();
    if (!java) {
      this.setStatus(false, `JD2 を動かす java がありません (${j.javaExe})。scripts/fetch-tools.ps1 を実行するか config.json の jd2.javaExe を設定してください`);
      return;
    }
    // Application.isHeadless() は GraphicsEnvironment.isHeadless() を見るだけなので、
    // このシステムプロパティひとつで GUI もトレイもクリップボード監視も起動しなくなる。
    const args = j.headless ? ['-Djava.awt.headless=true'] : [];
    args.push('-Xmx1024m', '-jar', jar);
    log(`[jd2] 起動します (${j.headless ? 'headless' : 'GUI'})`);

    // windowsHide でコンソール窓を出さない。stdout/stderr は拾うが、JD2 は起動するだけで
    // 500 行近く吐くので、手当てが要る行だけに絞る (全文は tools/jd2/logs に残っている)。
    const proc = spawn(java, args, { cwd: j.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let relayed = 0;
    const explained = new Set<string>();
    const relay = (d: unknown) => {
      if (relayed > RELAY_LIMIT) return;
      for (const raw of String(d).split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || !JD2_NOTEWORTHY.test(line)) continue;
        const benign = JD2_BENIGN.find(([re]) => re.test(line));
        if (benign) {
          if (explained.has(benign[1])) continue;
          explained.add(benign[1]);
          log(`[jd2] ${benign[1]}`);
          continue;
        }
        if (++relayed > RELAY_LIMIT) {
          log(`[jd2:out] これ以上は省略します。続きは ${path.join(j.dir, 'logs')} を見てください`);
          return;
        }
        log(`[jd2:out] ${line.slice(0, 300)}`);
      }
    };
    proc.stdout?.on('data', relay);
    proc.stderr?.on('data', relay);
    // JD2 のランチャーはアップデート後に別 JVM へ乗り換えることがある。つまりこのプロセスの
    // 終了 = JD2 の終了とは限らないので、生死は API の応答だけで判断する。
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      if (!this.stopping) log(`[jd2] 起動プロセスが終了しました (code ${code})`);
    });
    this.proc = proc;
    this.launched = true;
    this.headless = j.headless;
    this.writePid(proc.pid);

    const deadline = Date.now() + Math.max(30, j.startTimeoutSec) * 1000;
    while (Date.now() < deadline) {
      await sleep(2000);
      let up = false;
      try { await this.api<unknown>('/jd/version'); up = true; } catch { /* まだ立ち上がっていない */ }
      if (!up) continue;
      await this.check();
      await this.detectHeadless();
      return;
    }
    this.setStatus(false, `JD2 が ${j.startTimeoutSec} 秒以内に応答しませんでした (初回は自動アップデートに数分かかります)`);
  }

  private resolveJava(): string | null {
    const exe = this.cfg.jd2.javaExe;
    if (exe && fs.existsSync(exe)) return exe;
    const noExt = exe.replace(/\.exe$/i, '');   // Windows 以外の JRE 配置
    if (noExt !== exe && fs.existsSync(noExt)) return noExt;
    return null;
  }

  /**
   * JD2 を終了させる。HTTP 経由なので、PowerDowner が前回ハードキルされて取り残された
   * JD2 でも (起動時に引き継いだ上で) 片付けられる。
   */
  private async shutdownJd2(): Promise<void> {
    if (!this.available && !this.launched) return;
    let asked = false;
    try {
      await this.api('/system/exitJD');
      asked = true;
    } catch (e) {
      log(`[jd2] exitJD に失敗: ${(e as Error).message}`);
    }
    for (let i = 0; asked && i < 15; i++) {
      await sleep(1000);
      try { await this.api<unknown>('/jd/version'); } catch { break; }   // API が黙れば終了できている
    }
    if (this.proc && this.proc.exitCode === null) {
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.clearPid();
    log('[jd2] JD2 を終了しました');
  }

  /** 画面の無い JD2 を手で止める最後の手段 (scripts/stop-jd2.cmd が読む) */
  private writePid(pid: number | undefined): void {
    try { fs.writeFileSync(path.join(this.cfg.dataDir, 'jd2.pid'), String(pid ?? '')); } catch { /* ignore */ }
  }

  private clearPid(): void {
    try { fs.rmSync(path.join(this.cfg.dataDir, 'jd2.pid'), { force: true }); } catch { /* ignore */ }
  }

  /**
   * JD2 が headless かどうかを本人に聞く。答えが取れなければ config の宣言を信じる
   * (PowerDowner が起動したのなら、起動時に渡したフラグがそのまま答え)。
   */
  private async detectHeadless(): Promise<void> {
    let headless = this.cfg.jd2.headless;
    try {
      // 実機確認 (build 48637): {"archFamily":..., "headless":true, ...} が返る
      const infos = await this.api<{ headless?: boolean }>('/system/getSystemInfos');
      if (typeof infos?.headless === 'boolean') headless = infos.headless;
    } catch { /* この版の Deprecated API に無ければ config の宣言で進む */ }
    this.headless = headless;
    log(headless
      ? '[jd2] headless で動作中。CAPTCHA は JD2 では解けないのでブラウザ経路へ回します'
      : '[jd2] GUI ありで動作中。CAPTCHA は JD2 の画面で解けます');
  }

  // ---- API 呼び出し ------------------------------------------------------

  async api<T>(endpoint: string, params: unknown[] = []): Promise<T> {
    const qs = params.map((p) => encodeURIComponent(JSON.stringify(p))).join('&');
    const url = `${this.cfg.jd2.apiUrl}${endpoint}${qs ? '?' + qs : ''}`;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      const text = await res.text();
      let body: unknown = null;
      try { body = JSON.parse(text); } catch { body = text; }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const o = body as Record<string, unknown>;
        if ('type' in o && 'src' in o) throw new Error(`JD2 API ${endpoint}: ${String(o.type)} (${String(o.data)})`);
        if ('data' in o && Object.keys(o).every((k) => k === 'data' || k === 'rid' || k === 'ts')) return o.data as T;
      }
      if (!res.ok) throw new Error(`JD2 API ${res.status} ${endpoint}: ${text.slice(0, 200)}`);
      return body as T;
    } finally {
      clearTimeout(t);
    }
  }

  private pkgName(jobId: string): string {
    return `PD-${jobId}`;
  }

  /** JD2 に書かせる場所。UNC には書けないので、手元で受けて完了後に移す (isUnc 参照) */
  private saveDir(job: Job): string {
    return isUnc(job.destDir) ? path.join(this.cfg.dataDir, 'jd2-staging', job.id) : job.destDir;
  }

  /**
   * 手元で受けたものを本来の保存先へ移し、落ちたリンクの名前 → 移した後の名前を返す。
   * 共有フォルダへはボリュームを跨ぐので rename できず、コピーして消す。
   * 同名が先にあれば上書きせず連番にする (aria2 と同じ扱い)。
   */
  private async deliver(job: Job, staging: string): Promise<Map<string, string>> {
    const renamed = new Map<string, string>();
    await fs.promises.mkdir(job.destDir, { recursive: true });
    for (const entry of await fs.promises.readdir(staging)) {
      const src = path.join(staging, entry);
      const name = uniqueName(job.destDir, entry, (p) => fs.existsSync(p));
      const dst = path.join(job.destDir, name);
      try {
        await fs.promises.rename(src, dst);
      } catch {
        await fs.promises.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
        await fs.promises.rm(src, { recursive: true, force: true });
      }
      renamed.set(entry, name);
    }
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => { /* 空フォルダが残るだけ */ });
    return renamed;
  }

  private queryLinkgrabberLinks(filter: Record<string, unknown>): Promise<Jd2Link[]> {
    return this.api<Jd2Link[]>('/linkgrabberv2/queryLinks', [{
      availability: true, host: true, url: true, bytesTotal: true, enabled: true, startAt: 0, maxResults: -1, ...filter,
    }]).then((r) => r ?? []);
  }

  private queryDownloadLinks(filter: Record<string, unknown>): Promise<Jd2Link[]> {
    return this.api<Jd2Link[]>('/downloadsV2/queryLinks', [{
      bytesLoaded: true, bytesTotal: true, speed: true, status: true, finished: true, skipped: true,
      running: true, enabled: true, host: true, url: true, startAt: 0, maxResults: -1, ...filter,
    }]).then((r) => r ?? []);
  }

  private activeLinkIds(exceptJobId?: string): Set<number> {
    const s = new Set<number>();
    for (const [id, tr] of this.tracked) if (id !== exceptJobId) for (const l of tr.linkIds) s.add(l);
    return s;
  }

  /**
   * 同じ URL のリンクが JD2 に残っていると重複扱いで新規追加が黙殺されるので、先に消す。
   * ダウンロード一覧側は、他のジョブが追跡中のものは触らない。
   */
  private async cleanupUrl(url: string, jobId: string): Promise<void> {
    try {
      const lg = await this.queryLinkgrabberLinks({});
      const ids = lg.filter((l) => l.url === url).map((l) => l.uuid);
      if (ids.length) await this.api('/linkgrabberv2/removeLinks', [ids, []]);
    } catch (e) { log(`[jd2] cleanup(linkgrabber) ${(e as Error).message}`); }
    try {
      const keep = this.activeLinkIds(jobId);
      const dl = await this.queryDownloadLinks({});
      const ids = dl.filter((l) => l.url === url && !keep.has(l.uuid)).map((l) => l.uuid);
      if (ids.length) await this.api('/downloadsV2/removeLinks', [ids, []]);
    } catch (e) { log(`[jd2] cleanup(downloads) ${(e as Error).message}`); }
  }

  // ---- ジョブ操作 --------------------------------------------------------

  async add(job: Job): Promise<string> {
    await this.cleanupUrl(job.url, job.id);
    const r = await this.api<{ id?: number } | null>('/linkgrabberv2/addLinks', [{
      links: job.url,
      destinationFolder: this.saveDir(job),
      packageName: this.pkgName(job.id),
      autostart: false,          // 自分で movetoNewPackage → moveToDownloadlist する
      autoExtract: false,
      overwritePackagizerRules: true,
      deepDecrypt: false,
      assignJobID: true,
    }]);
    const crawlJobId = r && typeof r === 'object' && typeof r.id === 'number' ? r.id : null;
    if (crawlJobId === null) throw new Error('JD2 がクロールジョブ ID を返しませんでした');
    this.tracked.set(job.id, {
      job, phase: 'crawl', crawlJobId, linkIds: [], addedAt: Date.now(), movedAt: 0, humanWaiting: false, sawCaptcha: false, captchaErrorSince: 0, limitedSince: 0, limitReported: false,
    });
    return String(crawlJobId);
  }

  /** 再起動後の復元。保存済みリンク UUID → URL 一致の順で探す */
  async reattach(job: Job): Promise<boolean> {
    if (!this.available) return false;
    const saved = Array.isArray(job.meta.jd2LinkIds) ? (job.meta.jd2LinkIds as number[]) : [];
    let links: Jd2Link[] = [];
    if (saved.length) links = await this.queryDownloadLinks({ linkUUIDs: saved }).catch(() => []);
    if (links.length === 0) links = (await this.queryDownloadLinks({}).catch(() => [])).filter((l) => l.url === job.url);
    if (links.length > 0) {
      this.tracked.set(job.id, {
        job, phase: 'download', crawlJobId: null, linkIds: links.map((l) => l.uuid),
        addedAt: Date.now(), movedAt: Date.now(), humanWaiting: false, sawCaptcha: true, captchaErrorSince: 0, limitedSince: 0, limitReported: false,
      });
      return true;
    }
    const lg = (await this.queryLinkgrabberLinks({}).catch(() => [])).filter((l) => l.url === job.url);
    if (lg.length > 0) {
      // クロールは終わっているので、そのままダウンロードへ移す段階から再開
      await this.promote(job, lg).catch((e) => log(`[jd2] reattach promote: ${(e as Error).message}`));
      return this.tracked.has(job.id);
    }
    return false;
  }

  /** スキップ扱いのリンクを解除して JD2 に再挑戦させる (CAPTCHA タイムアウト後など) */
  async unskip(job: Job): Promise<void> {
    const tr = this.tracked.get(job.id);
    const ids = tr?.linkIds.length ? tr.linkIds : (Array.isArray(job.meta.jd2LinkIds) ? (job.meta.jd2LinkIds as number[]) : []);
    if (ids.length === 0) throw new Error('JD2 側のリンクが見つかりません。再試行してください');
    await this.api('/downloadsV2/unskip', [[], ids, null]);
    await this.api('/downloadsV2/resumeLinks', [ids, []]).catch(() => { /* ignore */ });
    await this.api('/downloadcontroller/start').catch(() => { /* ignore */ });
    if (tr) tr.humanWaiting = false;
  }

  async cancel(job: Job): Promise<void> {
    const tr = this.tracked.get(job.id);
    this.tracked.delete(job.id);
    // 追跡を先に手放してから cancel が呼ばれる経路がある (ブラウザ引き継ぎなど)。
    // そこで linkIds を見失うと JD2 の一覧にリンクが残り、枠を掴んだまま
    // 「待機」し続けて他のジョブを詰まらせる。永続化しておいた ID で拾い直す
    const saved = Array.isArray(job.meta.jd2LinkIds) ? (job.meta.jd2LinkIds as number[]) : [];
    const ids = [...new Set([...(tr?.linkIds ?? []), ...saved])];
    try {
      if (tr?.crawlJobId !== null && tr?.crawlJobId !== undefined) {
        const lg = await this.queryLinkgrabberLinks({ jobUUIDs: [tr.crawlJobId] });
        ids.push(...lg.map((l) => l.uuid));
      }
      if (ids.length) {
        await this.api('/linkgrabberv2/removeLinks', [ids, []]).catch(() => { /* ignore */ });
        await this.api('/downloadsV2/removeLinks', [ids, []]).catch(() => { /* ignore */ });
      }
    } catch (e) { log(`[jd2] cancel: ${(e as Error).message}`); }
  }

  // ---- 監視 --------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this.available || this.tracked.size === 0) return;
    const captchas = await this.api<Jd2Captcha[]>('/captcha/list').catch(() => [] as Jd2Captcha[]) ?? [];
    this.emitCaptchaNotice(captchas);

    for (const [jobId, tr] of [...this.tracked]) {
      try {
        if (tr.phase === 'crawl') await this.pollCrawl(jobId, tr);
        else await this.pollDownload(jobId, tr, captchas);
      } catch (e) {
        log(`[jd2] poll(${jobId}): ${(e as Error).message}`);
      }
    }

    // 追いかけている最中に制御が止まることがある (下記参照)。毎回見て、止まっていれば戻す
    if ([...this.tracked.values()].some((tr) => tr.phase === 'download')) {
      await this.ensureDownloading();
    }
  }

  /**
   * JD2 のダウンロード制御が動いていなければ動かす。
   *
   * moveToDownloadlist はリンクを一覧に置くだけで、制御が IDLE のままなら 1 本も走らない。
   * JD2 は手持ちを全部落とし終えると IDLE に戻るので、そこへ次のジョブを足しても
   * 再開しない — 「downloading と表示されたまま 0 B/s」で止まるのはこれが原因になる。
   *
   * 状態を見てから叩くのは、RUNNING 中に start を投げても意味が無いから。
   * 失敗しても黙って進む — JD2 が落ちているなら他の呼び出しが先に気づく。
   */
  private async ensureDownloading(): Promise<void> {
    const state = await this.api<string>('/downloadcontroller/getCurrentState').catch(() => null);
    if (typeof state === 'string' && /RUNNING/i.test(state)) return;
    await this.api('/downloadcontroller/start').catch(() => { /* ignore */ });
    log(`[jd2] ダウンロード制御が ${state ?? '不明'} だったので開始しました`);
  }

  private async pollCrawl(jobId: string, tr: Tracked): Promise<void> {
    const elapsed = Date.now() - tr.addedAt;
    const jobs = await this.api<Jd2CrawlerJob[]>('/linkgrabberv2/queryLinkCrawlerJobs', [{ jobIds: [tr.crawlJobId], collectorInfo: true }])
      .catch(() => [] as Jd2CrawlerJob[]) ?? [];
    const cj = jobs.find((j) => j.jobId === tr.crawlJobId);
    const busy = cj ? Boolean(cj.crawling || cj.checking) : false;

    const links = await this.queryLinkgrabberLinks({ jobUUIDs: [tr.crawlJobId] });
    if (links.length === 0) {
      if ((!busy && elapsed > CRAWL_IDLE_MS) || elapsed > CRAWL_GRACE_MS) {
        // 未対応サイトの可能性が高い。自前のブラウザ経路で試す
        this.tracked.delete(jobId);
        this.cb.onNeedsBrowser(jobId, 'JD2 がリンクを認識できませんでした (未対応サイトの可能性)');
      } else {
        this.cb.onProgress(jobId, { bytesTotal: 0, bytesDone: 0, speed: 0, detail: 'JD2 が解析中' });
      }
      return;
    }
    if (busy) {
      this.cb.onProgress(jobId, { bytesTotal: sum(links, 'bytesTotal'), bytesDone: 0, speed: 0, detail: `JD2 が解析中 (${links.length} 件)` });
      return;
    }
    const unknown = links.some((l) => l.availability === 'UNKNOWN' || l.availability === 'TEMP_UNKNOWN');
    if (unknown && elapsed < AVAIL_WAIT_MS) {
      this.cb.onProgress(jobId, { bytesTotal: sum(links, 'bytesTotal'), bytesDone: 0, speed: 0, detail: 'JD2 がオンライン確認中' });
      return;
    }
    await this.promote(tr.job, links);
  }

  /** LinkGrabber 上のリンクを、名前と保存先を強制した上でダウンロード一覧へ移す */
  private async promote(job: Job, links: Jd2Link[]): Promise<void> {
    const offline = links.filter((l) => l.availability === 'OFFLINE').map((l) => l.uuid);
    const online = links.filter((l) => l.availability !== 'OFFLINE').map((l) => l.uuid);
    if (offline.length) await this.api('/linkgrabberv2/removeLinks', [offline, []]).catch(() => { /* ignore */ });
    if (online.length === 0) {
      this.tracked.delete(job.id);
      this.cb.onFailed(job.id, 'JD2: リンクがオフラインです');
      return;
    }
    await this.api('/linkgrabberv2/movetoNewPackage', [online, [], this.pkgName(job.id), this.saveDir(job)]);
    await this.api('/linkgrabberv2/moveToDownloadlist', [online, []]);
    // 一覧に置くだけでは走らない。制御が止まっていれば動かす
    await this.ensureDownloading();
    this.tracked.set(job.id, {
      job, phase: 'download', crawlJobId: null, linkIds: online, addedAt: Date.now(), movedAt: Date.now(), humanWaiting: false, sawCaptcha: false, captchaErrorSince: 0, limitedSince: 0, limitReported: false,
    });
    this.cb.onLinkIds(job.id, online);
    const name = links.find((l) => l.availability !== 'OFFLINE')?.name;
    this.cb.onProgress(job.id, { bytesTotal: sum(links, 'bytesTotal'), bytesDone: 0, speed: 0, filename: online.length === 1 ? name : undefined, detail: 'JD2 のダウンロード一覧へ移動' });
    log(`[jd2] ${job.id}: ${online.length} リンクをダウンロード一覧へ (${name ?? ''})`);
  }

  private async pollDownload(jobId: string, tr: Tracked, captchas: Jd2Captcha[]): Promise<void> {
    const links = await this.queryDownloadLinks({ linkUUIDs: tr.linkIds });
    if (links.length === 0) {
      if (Date.now() - tr.movedAt > MOVED_GRACE_MS) {
        this.tracked.delete(jobId);
        this.cb.onFailed(jobId, 'JD2 のダウンロード一覧にリンクがありません (JD2 側で削除された可能性)');
      }
      return;
    }
    const total = sum(links, 'bytesTotal');
    const loaded = links.reduce((a, l) => a + (l.finished ? Number(l.bytesTotal ?? l.bytesLoaded ?? 0) : Number(l.bytesLoaded ?? 0)), 0);
    const speed = sum(links, 'speed');

    // status 文字列はローカライズされているので判定に使わず、真偽値だけで見る
    if (links.every((l) => l.finished === true)) {
      this.tracked.delete(jobId);
      let name = links[0]?.name ?? null;
      const staging = this.saveDir(tr.job);
      if (staging !== tr.job.destDir) {
        this.cb.onProgress(jobId, { bytesTotal: total, bytesDone: loaded, speed: 0, detail: '保存先へ移動中' });
        try {
          const renamed = await this.deliver(tr.job, staging);
          if (name) name = renamed.get(name) ?? name;
          log(`[jd2] ${jobId}: ${staging} -> ${tr.job.destDir} へ移しました`);
        } catch (e) {
          this.cb.onFailed(jobId, `落とし終えましたが保存先へ移せませんでした (${(e as Error).message})。ファイルは ${staging} に残っています`);
          return;
        }
      }
      this.cb.onDone(jobId, name);
      return;
    }

    const pending = links.filter((l) => !l.finished);
    const linkIdSet = new Set(pending.map((l) => l.uuid));
    const hostSet = new Set(pending.map((l) => (l.host ?? '').toLowerCase()));
    const captcha = captchas.find((c) => (c.link !== undefined && linkIdSet.has(c.link)) || hostSet.has((c.hoster ?? '').toLowerCase()));

    // hCaptcha / reCAPTCHA / Turnstile は JD2 のダイアログでは解けない (拡張機能が必要で、
    // その拡張は配布終了)。実サイト上で解けるブラウザ経路へすぐ回す。
    // headless の JD2 はそもそもダイアログを出せる画面が無いので、種類を問わず同じ扱い。
    if (captcha && (this.headless || needsBrowserSolver(captcha))) {
      this.tracked.delete(jobId);
      const kind = captcha.type ?? captcha.captchaCategory ?? 'interactive';
      this.cb.onNeedsBrowser(jobId, this.headless
        ? `headless の JD2 では CAPTCHA を出せません (${kind})`
        : `JD2 では解けない CAPTCHA (${kind})`);
      return;
    }

    // 「wrong captcha」「Blocked by Cloudflare」等で進まないまま堂々巡りになるケース
    // (frdl, mexa.sh など) もブラウザへ回す
    const captchaStuck = loaded === 0
      && pending.some((l) => /captcha|キャプチャ|cloudflare|blocked/i.test(l.status ?? ''));
    if (captchaStuck && !captcha) {
      if (tr.captchaErrorSince === 0) tr.captchaErrorSince = Date.now();
      else if (Date.now() - tr.captchaErrorSince > 60_000) {
        this.tracked.delete(jobId);
        this.cb.onNeedsBrowser(jobId, `JD2 が CAPTCHA を処理できません (${pending[0].status ?? 'captcha error'})`);
        return;
      }
    } else if (!captchaStuck) {
      tr.captchaErrorSince = 0;
    }

    let humanDetail = '';
    if (captcha) {
      tr.sawCaptcha = true;
      humanDetail = 'JD2 が CAPTCHA 入力を待っています。JD2 のウィンドウで解いてください';
    } else if (pending.every((l) => l.skipped)) {
      // 保存先やディスクの都合でのスキップは人間判定ではない。ブラウザで試し直しても同じ所で転ぶ。
      // JD2 にリンクを残すと、制御を start するたびに同じスキップを繰り返す亡霊になるので消しておく
      const notHuman = pending.find((l) => SKIP_NOT_HUMAN.test(l.status ?? ''));
      if (notHuman) {
        await this.cancel(tr.job);
        this.cb.onFailed(jobId, `JD2 がスキップしました (${notHuman.status})`);
        return;
      }
      // ダイアログを出さずにスキップ = JD2 が扱えない種類の人間判定 (Cloudflare Turnstile など)。
      // headless なら「JD2 の画面で解き直してもらう」当てが無いので、ダイアログを見たかどうかに
      // 関わらずブラウザへ回す。人間待ちのまま放置されるのが一番まずい。
      if (!tr.sawCaptcha || this.headless) {
        this.tracked.delete(jobId);
        this.cb.onNeedsBrowser(jobId, `JD2 が扱えない人間判定 (${pending[0].status ?? 'skipped'})`);
        return;
      }
      humanDetail = `JD2 がスキップしました (${pending[0].status ?? 'skipped'})。「JD2 で再開」で再挑戦できます`;
    }
    const waiting = humanDetail !== '';
    if (waiting !== tr.humanWaiting) {
      tr.humanWaiting = waiting;
      this.cb.onWaitingHuman(jobId, waiting, humanDetail);
    }

    // アップローダの同時ダウンロード上限。すぐには移さない — 上限は数分で空くことがあり、
    // 落ちやすいホストを毎回手放すと、結局落ちにくいほうへ流れてしまう。
    // tracked は消さない。切り替え側が cancel でリンクを片付けられるようにしておく
    const limited = !waiting && speed === 0 && pending.some((l) => HOST_LIMIT.test(l.status ?? ''));
    if (!limited) {
      tr.limitedSince = 0;
    } else if (tr.limitedSince === 0) {
      tr.limitedSince = Date.now();
    } else if (!tr.limitReported && Date.now() - tr.limitedSince >= this.cfg.mirrors.hostLimitWaitSec * 1000) {
      tr.limitReported = true;
      this.cb.onHostLimited(jobId, pending.find((l) => HOST_LIMIT.test(l.status ?? ''))?.status ?? 'ホストの同時ダウンロード上限');
      return;
    }

    this.cb.onProgress(jobId, {
      bytesTotal: total,
      bytesDone: loaded,
      speed,
      filename: links.length === 1 ? links[0].name : undefined,
      detail: pending[0]?.status ?? '',
    });
  }

  private emitCaptchaNotice(captchas: Jd2Captcha[]): void {
    const hosts = [...new Set(captchas.map((c) => c.hoster ?? '?'))].sort();
    const key = `${captchas.length}:${hosts.join(',')}`;
    if (key === this.lastCaptchaKey) return;
    this.lastCaptchaKey = key;
    bus.emit('captcha', { engine: 'jd2', pending: captchas.length, hosts, headless: this.headless });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * その PID がまだ JDownloader のものか。PID は使い回されるので、名前だけでなく
 * コマンドラインに JDownloader.jar が入っていることまで確かめる。
 */
function isJd2Process(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    const ps = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`,
    ], { windowsHide: true });
    let out = '';
    ps.stdout?.on('data', (d) => { out += String(d); });
    ps.on('error', () => resolve(false));
    ps.on('close', () => resolve(/JDownloader\.jar/i.test(out)));
  });
}

function sum(links: Jd2Link[], key: 'bytesTotal' | 'bytesLoaded' | 'speed'): number {
  return links.reduce((a, l) => a + Number(l[key] ?? 0), 0);
}
