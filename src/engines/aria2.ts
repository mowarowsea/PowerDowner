import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Job, ResolvedDownload, EngineStatus } from '../types.js';
import { bus, log } from '../events.js';
import { splitFilename, uniqueName } from '../naming.js';

export interface Progress {
  bytesTotal: number;
  bytesDone: number;
  speed: number;
  filename?: string;
  /** エンジン側の状態文言 (表示専用。JD2 はローカライズ済み文字列を返す) */
  detail?: string;
}

export interface EngineCallbacks {
  onProgress(jobId: string, p: Progress): void;
  onDone(jobId: string, filename: string | null): void;
  onFailed(jobId: string, error: string): void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

interface Aria2Status {
  status: 'active' | 'waiting' | 'paused' | 'error' | 'complete' | 'removed';
  totalLength?: string;
  completedLength?: string;
  downloadSpeed?: string;
  errorCode?: string;
  errorMessage?: string;
  files?: { path: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** aria2 の終了コード (https://aria2.github.io/manual/en/html/aria2c.html#exit-status) を人向けの言葉に */
const ARIA2_ERRORS: Record<string, string> = {
  '1': '原因不明のエラーで止まりました',
  '2': 'サーバーから応答がなくタイムアウトしました',
  '3': 'サーバーにファイルが見つかりません (削除済みか、リンクの期限切れ)',
  '4': 'どのリンクからもファイルが見つかりませんでした',
  '5': '速度が遅すぎるので打ち切りました',
  '6': '通信エラーで切れました',
  '7': '完了前に aria2 が終了しました',
  '8': 'サーバーが途中からの再開に対応していません',
  '9': 'ディスクの空き容量が足りません',
  '10': '落としかけのファイルと中身が合いません',
  '11': '同じファイルを既に落としています',
  '12': '同じトレントを既に落としています',
  '13': '同じ名前のファイルが既にあります',
  '14': 'ファイル名の変更に失敗しました',
  '15': '既存のファイルを開けませんでした',
  '16': 'ファイルを作れませんでした (権限やパスを確認してください)',
  '17': 'ファイルの読み書きでエラーが起きました',
  '18': '保存先フォルダを作れませんでした',
  '19': 'サーバーの名前解決に失敗しました (ネット接続を確認してください)',
  '20': 'Metalink を読めませんでした',
  '21': 'FTP のコマンドが失敗しました',
  '22': 'サーバーから想定外の応答が返りました',
  '23': 'リダイレクトが多すぎます',
  '24': 'サーバーの認証に失敗しました (ログインが必要かもしれません)',
  '25': 'トレントファイルを読めませんでした',
  '26': 'トレントファイルが壊れています',
  '27': 'マグネットリンクが正しくありません',
  '28': 'aria2 に渡したオプションが正しくありません',
  '29': 'サーバーが混雑中かメンテナンス中です',
  '30': 'aria2 への指示を読めませんでした',
  '32': 'チェックサムが一致しません (ファイルが壊れています)',
};

/**
 * 失敗理由の表示文言。末尾の `(aria2 code N)` は queue.ts が引き直し判定に使うので必ず残す
 */
export function aria2ErrorText(code: string | undefined, raw: string | undefined): string {
  const text = (code && ARIA2_ERRORS[code]) ?? raw ?? '原因不明のエラーで止まりました';
  return `${text} (aria2 code ${code ?? '?'})`;
}

/**
 * aria2c を子プロセスとして起動し、WebSocket JSON-RPC で操作する。
 * セッションファイルを使うので、aria2 と本アプリのどちらが再起動しても
 * GID が保たれ、途中から再開できる。
 */
export class Aria2Engine {
  readonly name = 'aria2' as const;
  available = false;
  detail = '未起動';

  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private gidToJob = new Map<string, string>();
  private pollTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private adopted = false;

  constructor(private cfg: Config, private cb: EngineCallbacks) {}

  status(): EngineStatus {
    return { name: 'aria2', available: this.available, detail: this.detail };
  }

  async start(): Promise<void> {
    // 前回のプロセスが残っていれば (Windows は親を殺しても子が残る) それを引き継ぐ。
    // 進行中のダウンロードも aria2 側に残っているので、そのまま続きから追跡できる。
    if (await this.tryAdopt()) {
      this.pollTimer = setInterval(() => { this.poll().catch(() => { /* ignore */ }); }, 1000);
      return;
    }
    const exe = this.cfg.aria2.exe;
    if (!fs.existsSync(exe)) {
      this.setStatus(false, `aria2c が見つかりません (${exe})。scripts/fetch-tools.ps1 を実行してください`);
      return;
    }
    this.spawnProcess();
    await this.connect();
    this.pollTimer = setInterval(() => { this.poll().catch(() => { /* ignore */ }); }, 1000);
  }

  private async tryAdopt(): Promise<boolean> {
    try {
      await this.openWs(`ws://127.0.0.1:${this.cfg.aria2.rpcPort}/jsonrpc`);
      const v = await this.call<{ version: string }>('aria2.getVersion');
      this.adopted = true;
      this.setStatus(true, `aria2 ${v.version} (既存プロセスを引き継ぎ)`);
      return true;
    } catch {
      this.ws?.close();
      this.ws = null;
      return false;
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.ws) {
      try { await Promise.race([this.call('aria2.shutdown'), sleep(3000)]); } catch { /* ignore */ }
      this.ws.close();
    }
    if (this.proc && this.proc.exitCode === null) {
      await sleep(1000);
      if (this.proc.exitCode === null) this.proc.kill();
    }
  }

  private setStatus(available: boolean, detail: string): void {
    const changed = this.available !== available || this.detail !== detail;
    this.available = available;
    this.detail = detail;
    if (changed) {
      log(`[aria2] ${detail}`);
      bus.emit('engine', this.status());
    }
  }

  private spawnProcess(): void {
    const a = this.cfg.aria2;
    const sessionFile = path.join(this.cfg.dataDir, 'aria2.session');
    if (!fs.existsSync(sessionFile)) fs.writeFileSync(sessionFile, '');
    const args = [
      '--enable-rpc',
      '--rpc-listen-all=false',
      `--rpc-listen-port=${a.rpcPort}`,
      `--rpc-secret=${a.secret}`,
      // 途切れない設定
      '--continue=true',
      '--max-tries=0',
      '--retry-wait=10',
      '--timeout=60',
      '--connect-timeout=30',
      `--split=${a.splits}`,
      `--max-connection-per-server=${Math.min(16, a.splits)}`,
      '--min-split-size=1M',
      `--max-concurrent-downloads=${a.maxConcurrent}`,
      '--file-allocation=none',
      '--auto-file-renaming=false',
      '--allow-overwrite=false',
      '--content-disposition-default-utf8=true',
      '--remote-time=true',
      '--console-log-level=warn',
      '--quiet=true',
      `--save-session=${sessionFile}`,
      `--input-file=${sessionFile}`,
      '--save-session-interval=30',
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) PowerDowner/0.1',
    ];
    const proc = spawn(a.exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    proc.stdout?.on('data', (d) => log(`[aria2] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => log(`[aria2!] ${String(d).trim()}`));
    proc.on('exit', (code) => {
      this.setStatus(false, `aria2c が終了しました (code ${code})`);
      this.ws?.close();
      this.ws = null;
      if (!this.stopping) {
        setTimeout(() => {
          this.spawnProcess();
          this.connect().catch(() => { /* ignore */ });
        }, 3000);
      }
    });
    this.proc = proc;
  }

  private async connect(): Promise<void> {
    const url = `ws://127.0.0.1:${this.cfg.aria2.rpcPort}/jsonrpc`;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await this.openWs(url);
        const v = await this.call<{ version: string }>('aria2.getVersion');
        this.setStatus(true, `aria2 ${v.version}`);
        return;
      } catch {
        await sleep(500);
      }
    }
    this.setStatus(false, 'aria2 RPC に接続できません');
  }

  private reconnecting: Promise<void> | null = null;

  /**
   * 接続が切れた後のつなぎ直し。同時に何度呼ばれても 1 本にまとめる。
   * 20 秒でつながらなければ、生き残っているのが応答しない aria2 だとみなして起動し直す。
   * 追いかけていた GID はそのまま残るので、つながり直せば poll が進捗と完了を拾い直す
   */
  private reconnect(): Promise<void> {
    this.reconnecting ??= (async () => {
      try {
        await this.connect();
        if (this.ws || this.stopping) return;
        log('[aria2] つなぎ直せないので aria2 を起動し直します');
        this.adopted = false;
        if (this.proc && this.proc.exitCode === null) {
          this.proc.kill();   // exit の側が起動し直して connect する
        } else if (fs.existsSync(this.cfg.aria2.exe)) {
          this.spawnProcess();
          await this.connect();
        }
      } finally {
        this.reconnecting = null;
      }
    })();
    return this.reconnecting;
  }

  /**
   * 渡す直前の確認。切れていたらつなぎ直しを待つ。
   * 接続が一瞬切れただけでジョブを失敗にしない (失敗にすると人が再試行を押すまで止まる)
   */
  async ready(): Promise<boolean> {
    if (this.ws && this.ws.readyState === 1) return true;
    if (this.stopping) return false;
    await Promise.race([this.reconnect(), sleep(25_000)]);
    return !!this.ws && this.ws.readyState === 1;
  }

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('ws error'));
      ws.onclose = (ev) => {
        const live = this.ws === ws;
        if (live) this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('aria2 接続が切れました'));
        this.pending.clear();
        if (!live || this.stopping) return;

        // 自前で起動したプロセスごと落ちた場合は、spawnProcess の exit が起動し直すので触らない
        if (this.proc && this.proc.exitCode !== null) return;
        // それ以外は、まずつなぎ直す。接続だけが切れて aria2 は生きていることがあり、
        // 放っておくと緑のまま一切受け付けなくなる (2026-09-24 に実際に起きた)。
        // 引き継いだプロセスが本当に消えていたら、つなぎ直しに失敗した先で起動し直す
        this.setStatus(false, `aria2 との接続が切れました (code ${ev.code})。つなぎ直します`);
        this.reconnect().catch(() => { /* ignore */ });
      };
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
    });
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }
    const list = Array.isArray(msg) ? msg : [msg];
    for (const m of list as Array<{ id?: unknown; error?: { message?: string }; result?: unknown; method?: string; params?: { gid?: string }[] }>) {
      if (m.id !== undefined && this.pending.has(String(m.id))) {
        const p = this.pending.get(String(m.id))!;
        this.pending.delete(String(m.id));
        if (m.error) p.reject(new Error(m.error.message ?? 'aria2 error'));
        else p.resolve(m.result);
      } else if (typeof m.method === 'string') {
        this.onNotification(m.method, m.params?.[0]?.gid);
      }
    }
  }

  private onNotification(method: string, gid?: string): void {
    if (!gid) return;
    const jobId = this.gidToJob.get(gid);
    if (!jobId) return;
    if (method === 'aria2.onDownloadComplete') this.finish(gid, jobId).catch((e) => log(`[aria2] finish error: ${e}`));
    else if (method === 'aria2.onDownloadError') this.fail(gid, jobId).catch((e) => log(`[aria2] fail error: ${e}`));
  }

  private async finish(gid: string, jobId: string): Promise<void> {
    if (!this.gidToJob.has(gid)) return;
    this.gidToJob.delete(gid);
    let file: string | null = null;
    try {
      const st = await this.call<Aria2Status>('aria2.tellStatus', [gid, ['files']]);
      file = fileNameOf(st) ?? null;
    } catch { /* ignore */ }
    this.cb.onDone(jobId, file);
    this.call('aria2.removeDownloadResult', [gid]).catch(() => { /* ignore */ });
  }

  private async fail(gid: string, jobId: string): Promise<void> {
    if (!this.gidToJob.has(gid)) return;
    this.gidToJob.delete(gid);
    let msg = 'aria2 error';
    try {
      const st = await this.call<Aria2Status>('aria2.tellStatus', [gid, ['errorCode', 'errorMessage']]);
      msg = aria2ErrorText(st.errorCode, st.errorMessage);
      if (st.errorMessage) log(`[aria2] ${st.errorMessage} (code ${st.errorCode ?? '?'})`);
    } catch { /* ignore */ }
    this.cb.onFailed(jobId, msg);
    this.call('aria2.removeDownloadResult', [gid]).catch(() => { /* ignore */ });
  }

  call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return Promise.reject(new Error('aria2 に未接続です'));
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: [`token:${this.cfg.aria2.secret}`, ...params] }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`aria2 ${method} がタイムアウトしました`));
      }, 30_000);
    });
  }

  /** ジョブを aria2 に投入し GID を返す */
  async add(job: Job, r: ResolvedDownload): Promise<string> {
    const opts: Record<string, string | string[]> = { dir: job.destDir, continue: 'true' };
    if (r.filename) opts.out = r.filename;
    if (r.headers?.length) opts.header = r.headers;
    if (r.checksum) opts.checksum = r.checksum;
    if (r.options) Object.assign(opts, r.options);
    // 連番付けは r.options の out も含めて最後に。ここを通さないと
    // 同名が既にある時に aria2 が code 13 で弾いて 1 バイトも落ちない
    const out = opts.out;
    if (typeof out === 'string') {
      if (r.resumable === false) discardPartial(job.destDir, out);
      opts.out = outNameFor(job.destDir, out, (p) => fs.existsSync(p));
    }
    const gid = await this.call<string>('aria2.addUri', [[r.url], opts]);
    this.gidToJob.set(gid, job.id);
    return gid;
  }

  /** 再起動後に既存 GID を追跡し直す。aria2 側に無ければ false */
  async reattach(job: Job): Promise<boolean> {
    if (!job.externalId) return false;
    try {
      const st = await this.call<Aria2Status>('aria2.tellStatus', [job.externalId, ['status', 'files']]);
      if (st.status === 'complete') {
        this.cb.onDone(job.id, fileNameOf(st) ?? job.filename);
        return true;
      }
      if (st.status === 'error' || st.status === 'removed') return false;
      this.gidToJob.set(job.externalId, job.id);
      return true;
    } catch {
      return false;
    }
  }

  async cancel(job: Job): Promise<void> {
    if (!job.externalId) return;
    this.gidToJob.delete(job.externalId);
    try { await this.call('aria2.forceRemove', [job.externalId]); } catch { /* ignore */ }
    try { await this.call('aria2.removeDownloadResult', [job.externalId]); } catch { /* ignore */ }
  }

  private async poll(): Promise<void> {
    if (!this.ws || this.gidToJob.size === 0) return;
    for (const [gid, jobId] of [...this.gidToJob]) {
      let st: Aria2Status;
      try {
        st = await this.call<Aria2Status>('aria2.tellStatus', [
          gid, ['status', 'totalLength', 'completedLength', 'downloadSpeed', 'files', 'errorMessage', 'errorCode'],
        ]);
      } catch {
        continue;
      }
      if (st.status === 'complete') { await this.finish(gid, jobId); continue; }
      if (st.status === 'error') { await this.fail(gid, jobId); continue; }
      this.cb.onProgress(jobId, {
        bytesTotal: Number(st.totalLength ?? 0),
        bytesDone: Number(st.completedLength ?? 0),
        speed: Number(st.downloadSpeed ?? 0),
        filename: fileNameOf(st),
      });
    }
  }
}

/**
 * aria2 に渡す保存名を決める。同名が既にあれば `... (2).rar` と後ろに連番を付ける。
 *
 * aria2 は `--allow-overwrite=false --auto-file-renaming=false` で回している。
 * 上書きさせないのは、同じ巻でも中身が違う (画質違い・修正版) ことがあるため
 * (`src/naming.ts` の `uniqueName` と同じ理由)。aria2 自身の連番に任せないのは、
 * `xxx.part2.rar` を `xxx.part2.1.rar` のように**拡張子側**に付けてしまい、
 * 分割書庫のベース名が揃わなくなって解凍できなくなるため。
 *
 * ただし中断したものの続き (`*.aria2` が残っている) は同じ名前で掴み直す。
 * ここで連番を付けると、落としかけを置き去りにして最初からやり直しになる。
 */
export function outNameFor(dir: string, file: string, exists: (p: string) => boolean): string {
  if (exists(path.join(dir, `${file}.aria2`))) return file;
  // 落としかけ (本体 + *.aria2) の名前も、他所が掴んでいるものとして避ける
  const taken = (name: string): boolean => {
    const p = path.join(dir, name);
    return exists(p) || exists(`${p}.aria2`);
  };
  if (!taken(file)) return file;

  // 書庫は `src/naming.ts` の規則に委ねる (分割書庫の連番を拡張子の手前へ戻すのはあちらの仕事)
  const { stem, ext } = splitFilename(file);
  if (ext) return uniqueName(dir, file, (p) => exists(p) || exists(`${p}.aria2`));

  // 書庫以外 (mp4 など) は素の拡張子を保ったまま連番を挟む。`splitFilename` は
  // 知らない拡張子を本体側に残すので、そのまま渡すと `動画.mp4 (2)` になって開けなくなる
  const raw = path.extname(stem);
  // 既に付いている連番は付け直す。`splitFilename` が書庫でそうしているのと揃える
  // (揃えないと 3 本目が `動画 (2) (2).mp4` になる)
  const base = (raw ? stem.slice(0, -raw.length) : stem).replace(/\s*\(\d{1,3}\)$/, '');
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} (${i})${raw}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base} (${Date.now()})${raw}`;
}

/**
 * 落としかけ (本体 + `*.aria2`) を捨てる。途中から落とせないサーバー向け。
 *
 * aria2 自身の `--always-resume=false` (続きが取れなければ最初から) にも頼れるが、
 * 1.37.0 は最初からに切り替えた直後にディスクキャッシュの不具合でプロセスごと
 * 落ちることがある (全ジョブが巻き添えになる) ので、渡す前にこちらで消しておく。
 * `*.aria2` が無いものは落とし終えたファイルなので触らない。
 */
export function discardPartial(dir: string, file: string): void {
  const p = path.join(dir, file);
  if (!fs.existsSync(`${p}.aria2`)) return;
  try {
    fs.rmSync(p, { force: true });
    fs.rmSync(`${p}.aria2`, { force: true });
    log(`[aria2] 途中から落とせないサーバーなので、落としかけを捨てて最初から: ${file}`);
  } catch (e) {
    log(`[aria2] 落としかけを捨てられませんでした: ${file} (${(e as Error).message})`);
  }
}

function fileNameOf(st: Aria2Status): string | undefined {
  const p = st.files?.[0]?.path;
  if (!p || p.startsWith('[')) return undefined;
  return path.basename(p);
}
