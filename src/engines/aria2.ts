import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import type { Job, ResolvedDownload, EngineStatus } from '../types.js';
import { bus, log } from '../events.js';

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

  private openWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => { this.ws = ws; resolve(); };
      ws.onerror = () => reject(new Error('ws error'));
      ws.onclose = () => {
        if (this.ws === ws) this.ws = null;
        for (const p of this.pending.values()) p.reject(new Error('aria2 接続が切れました'));
        this.pending.clear();
        // 引き継いだ外部プロセスが消えた場合は、自前で起動し直す
        if (this.adopted && !this.stopping) {
          this.adopted = false;
          this.setStatus(false, '引き継いだ aria2 が終了しました。再起動します');
          setTimeout(() => {
            if (!fs.existsSync(this.cfg.aria2.exe)) return;
            this.spawnProcess();
            this.connect().catch(() => { /* ignore */ });
          }, 1000);
        }
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
      msg = `${st.errorMessage ?? 'unknown'} (aria2 code ${st.errorCode ?? '?'})`;
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

function fileNameOf(st: Aria2Status): string | undefined {
  const p = st.files?.[0]?.path;
  if (!p || p.startsWith('[')) return undefined;
  return path.basename(p);
}
