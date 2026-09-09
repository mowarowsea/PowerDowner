import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { Db, now } from './db.js';
import type { Aria2Engine, Progress } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';
import type { Job, ResolvedDownload, User, MergeRecord } from './types.js';
import { decideItem, type ItemInput } from './library.js';
import { hostOf, pickFreeHostMirror, sortByPriority } from './mirrors.js';
import { bus, log } from './events.js';
import { toast } from './notify.js';

/**
 * 中身が HTML かどうか。頭だけ読んで判断する。
 * 拡張子では分からない — ホスターは `...v01.rar` のままエラーページを返してくる。
 */
function looksLikeHtml(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const read = fs.readSync(fd, buf, 0, 512, 0);
    const head = buf.subarray(0, read).toString('latin1').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml') && head.includes('<html');
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export interface AddInput {
  userId: number;
  urls: string[];
  destDir?: string | null;
}

/** DryEyes からの投入。1 件が 1 ファイルで、urls はその同一ファイルのミラー */
export interface AddItemsInput {
  userId: number;
  destDir?: string | null;
  items: ItemInput[];
}

export interface AddItemsResult {
  /** 投入元が結果を突き合わせられるよう、どの配列にも sourceKey を返す
   *  (created は Job.meta.sourceKey に入っている)。title は重複しうるので目印にならない */
  created: Job[];
  merged: { jobId: string; sourceKey: string | null; title: string | null; urls: string[] }[];
  skipped: { sourceKey: string | null; title: string | null; reason: string }[];
  invalid: { sourceKey: string | null; title: string | null; reason: string }[];
  /** 上限で切り捨てた件数 */
  truncated: number;
}

/**
 * 1 リクエストで受ける上限。監視を作り直して全増分が新規に見えた時の安全弁
 * (docs/ROADMAP.md 2 章「承認フロー」)。
 */
const MAX_ITEMS_PER_REQUEST = 20;

export class Queue {
  private pumping = false;
  private pumpAgain = false;

  constructor(
    private cfg: Config,
    private db: Db,
    private aria2: Aria2Engine,
    private jd2: Jd2Engine,
    private browser: BrowserEngine,
    private router: Router,
  ) {}

  // ---- エンジンからのコールバック -----------------------------------------

  onProgress = (jobId: string, p: Progress): void => {
    const cur = this.db.getJob(jobId);
    if (!cur || (cur.status !== 'downloading' && cur.status !== 'waiting_human' && cur.status !== 'waiting_site')) return;
    const patch: Partial<Job> = { bytesTotal: p.bytesTotal, bytesDone: p.bytesDone, speed: p.speed };
    if (p.filename && p.filename !== cur.filename) patch.filename = p.filename;
    if (p.detail !== undefined && p.detail !== cur.meta.detail) patch.meta = { detail: p.detail };
    this.emit(this.db.patchJob(jobId, patch));
  };

  onDone = (jobId: string, filename: string | null): void => {
    const cur = this.db.getJob(jobId);
    if (!cur) return;
    const name = filename ?? cur.filename;

    // エンジンの「終わった」を鵜呑みにしない。
    // 完了にすると台帳にも「持っている」と書かれ、次に同じ巻が来ても二度と落ちてこない —
    // 中身が無いものを完了にするのが一番高くつく間違いなので、実ファイルを見てから決める。
    const verdict = this.verifyDownload(cur, name);
    if (!verdict.ok) {
      // 失敗として扱えば、候補が残っていれば次のミラーへ回る
      this.onFailed(jobId, verdict.reason);
      return;
    }

    const job = this.db.patchJob(jobId, {
      status: 'done',
      filename: name,
      // 実ファイルの大きさが分かったならそれを正とする。エンジンによっては
      // 進捗を 1 度も報告しないまま終わるので、0 B のまま完了になってしまう
      bytesTotal: verdict.size > 0 ? verdict.size : cur.bytesTotal,
      bytesDone: verdict.size > 0 ? verdict.size
        : cur.bytesTotal > 0 ? cur.bytesTotal : cur.bytesDone,
      speed: 0,
      error: null,
      meta: { detail: '', humanDetail: '' },
    });
    // 台帳を確定させる。ここを落とすと、次に別サイトから同じ巻が来た時に弾けない
    const entry = this.db.findItemByJob(jobId);
    if (entry && entry.status === 'pending') this.db.patchItem(entry.id, { status: 'done' });
    log(`[queue] 完了: ${job?.filename ?? cur.url} (${verdict.size} B)`);
    this.emit(job);
  };

  /**
   * 落ちてきたものが本物か確かめる。
   *
   * 落ちなかったのに完了になる道が 2 つある:
   *   - 0 バイト。ワンクリックホスターの直リンクが切れていると起きる
   *   - HTML。期限切れリンクやエラーページを、そのままファイルとして保存してしまう
   *     (`rsdjf1me5yac` のような拡張子なしの数 KB が残るのはこれ)
   *
   * 実ファイルが見つからない時は落第にしない。JD2 はパッケージ名で掘ったフォルダへ
   * 別名で置くことがあり、見つけられないだけの完走を失敗にするほうが害が大きい。
   * その場合はエンジンの報告値で見て、1 バイトも受け取っていない時だけ弾く。
   */
  private verifyDownload(job: Job, filename: string | null): { ok: true; size: number } | { ok: false; reason: string } {
    const found = filename ? this.findDownloaded(job.destDir, filename) : null;

    if (found === null) {
      const reported = Math.max(job.bytesDone, job.bytesTotal);
      if (reported > 0) return { ok: true, size: 0 };
      return { ok: false, reason: '完了と言われましたが、ファイルが見つからず 1 バイトも受け取っていません' };
    }

    let size = 0;
    try {
      size = fs.statSync(found).size;
    } catch {
      return { ok: false, reason: `完了と言われましたが、保存先のファイルを読めません (${found})` };
    }

    if (size === 0) {
      return { ok: false, reason: '0 バイトで終わりました (直リンクが切れている可能性)' };
    }
    if (looksLikeHtml(found)) {
      return { ok: false, reason: `ファイルではなく Web ページが保存されました (${size} B。リンクの期限切れやエラーページの可能性)` };
    }
    return { ok: true, size };
  }

  /** 保存先から実ファイルを探す。JD2 はパッケージ名のフォルダを 1 段掘ることがある */
  private findDownloaded(destDir: string, filename: string): string | null {
    const direct = path.join(destDir, filename);
    if (fs.existsSync(direct)) return direct;
    try {
      for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const nested = path.join(destDir, entry.name, filename);
        if (fs.existsSync(nested)) return nested;
      }
    } catch { /* 保存先を読めないなら、見つからなかったのと同じ扱いでよい */ }
    return null;
  }

  onFailed = (jobId: string, error: string): void => {
    const cur = this.db.getJob(jobId);
    if (!cur) return;

    // ブラウザから aria2 へ引き継いだ直リンクが拒否された場合は、同じ URL をブラウザ自身に
    // 保存させれば通る見込みがある。まだ試していないなら、ミラーへ移る前にそちらを使い切る
    if (cur.engine === 'aria2' && cur.meta.via === 'browser' && cur.meta.browserDirect !== true) {
      const message = `${error} → 直リンクの引き継ぎに失敗しました。再試行するとブラウザ自身でダウンロードします`;
      const job = this.db.patchJob(jobId, {
        status: 'failed', speed: 0, error: message,
        meta: { browserDirect: true, humanDetail: '' },
      });
      log(`[queue] 失敗: ${cur.url} -> ${message}`);
      this.emit(job);
      return;
    }

    // 未試行の候補が残っていれば、失敗を確定させずに次のミラーへ回す。
    // ブラウザの人間待ちタイムアウトもここを通るので、詰まったまま放置されることがない
    if (this.toNextMirror(cur, error)) return;

    // 最後に試した候補も記録に残す。ここを飛ばすと「何を試して駄目だったか」が
    // 1 件分だけ欠けて、UI からも次の判断材料からも見えなくなる
    const tried = Array.isArray(cur.meta.tried) ? (cur.meta.tried as { url: string; error: string }[]) : [];
    const job = this.db.patchJob(jobId, {
      status: 'failed', speed: 0, error,
      meta: { humanDetail: '', tried: [...tried, { url: cur.url, error }] },
    });
    log(`[queue] 失敗: ${cur.url} -> ${error}`);
    this.emit(job);
  };

  /**
   * 次のミラー候補へ移す。候補が無ければ false を返し、呼び出し元が失敗を確定させる。
   * 失敗の確定はあくまで onFailed の 1 か所に保つ (docs/ROADMAP.md 4 章)。
   */
  private toNextMirror(cur: Job, error: string): boolean {
    const mirrors = Array.isArray(cur.meta.mirrors) ? (cur.meta.mirrors as string[]) : [];
    if (mirrors.length === 0) return false;

    const [next, ...rest] = mirrors;
    const tried = Array.isArray(cur.meta.tried) ? (cur.meta.tried as { url: string; error: string }[]) : [];
    const job = this.db.patchJob(cur.id, {
      status: 'queued',
      url: next,
      engine: null,
      externalId: null,
      error: null,
      speed: 0,
      // 別のファイルを取りに行くので、前の候補の進捗と名前は捨てる
      filename: null,
      bytesTotal: 0,
      bytesDone: 0,
      meta: {
        mirrors: rest,
        tried: [...tried, { url: cur.url, error }],
        // 経路の記憶も落とす。前の候補でブラウザに回っていても、次は経路判定からやり直す
        route: '', via: '', browserDirect: false, detail: '', humanDetail: '',
      },
    });
    log(`[queue] ミラー切替 (残り ${rest.length} 件): ${cur.url} -> ${next} (${error})`);
    this.emit(job);
    this.schedulePump();
    return true;
  }

  /**
   * 今のアップローダが同時ダウンロード数の上限で待たされている。
   * 空いている別のアップローダへ移す。移せなければ待たせたままにする。
   */
  onHostLimited = (jobId: string, reason: string): void => {
    this.toFreeHost(jobId, reason).catch((e) => log(`[queue] ホスト切替に失敗: ${(e as Error).message}`));
  };

  private async toFreeHost(jobId: string, reason: string): Promise<void> {
    const cur = this.db.getJob(jobId);
    if (!cur || cur.status !== 'downloading') return;

    const mirrors = Array.isArray(cur.meta.mirrors) ? (cur.meta.mirrors as string[]) : [];
    const next = pickFreeHostMirror(mirrors, this.busyHosts(cur.id), this.cfg.mirrors.priority);
    if (!next) {
      // 移せる先が無い。失敗にはしない — 上限は時間で空くので、待っていれば進む
      this.emit(this.db.patchJob(jobId, {
        speed: 0,
        meta: { detail: `${reason} (空いている別のアップローダが無いので待機)` },
      }));
      return;
    }

    // JD2 の待ち行列から外してから移す。残したままだと枠を掴んだままになる
    await this.detach(cur);

    // 今の URL は tried に落とさず末尾へ回す。上限は失敗ではないので、
    // ほかが全部駄目だった時にもう一度ここへ戻れるようにしておく
    const rest = [...mirrors.filter((u) => u !== next), cur.url];
    const job = this.db.patchJob(jobId, {
      status: 'queued', url: next, engine: null, externalId: null, error: null, speed: 0,
      filename: null, bytesTotal: 0, bytesDone: 0,
      meta: {
        mirrors: rest,
        route: '', via: '', browserDirect: false, detail: '', humanDetail: '',
      },
    });
    log(`[queue] ホスト上限で切替: ${cur.url} -> ${next} (${reason})`);
    this.emit(job);
    this.schedulePump();
  }

  /**
   * 今ほかのジョブが使っているホスト。
   * 同じところへ移し替えても同じ上限に当たるだけなので、候補から外す。
   */
  private busyHosts(exceptJobId: string): string[] {
    return this.db
      .listJobsByStatus(['resolving', 'downloading', 'waiting_human', 'waiting_site'])
      .filter((j) => j.id !== exceptJobId)
      .map((j) => hostOf(j.url))
      .filter(Boolean);
  }

  onSiteWait = (jobId: string, resumeAt: number, reason: string): void => {
    const at = new Date(resumeAt);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    this.emit(this.db.patchJob(jobId, {
      status: 'waiting_site',
      speed: 0,
      meta: { notBefore: resumeAt, waitReason: reason, detail: `${hhmm} に自動で再開 (${reason})`, humanDetail: '' },
    }));
  };

  onLinkIds = (jobId: string, linkIds: number[]): void => {
    this.emit(this.db.patchJob(jobId, { meta: { jd2LinkIds: linkIds } }));
  };

  onWaitingHuman = (jobId: string, waiting: boolean, detail: string): void => {
    const cur = this.db.getJob(jobId);
    if (!cur) return;
    if (waiting && (cur.status === 'downloading' || cur.status === 'waiting_human')) {
      if (cur.status !== 'waiting_human' || cur.meta.humanDetail !== detail) {
        this.emit(this.db.patchJob(jobId, { status: 'waiting_human', meta: { humanDetail: detail } }));
      }
      // headless 運用では人間待ちはほぼブラウザ経路にしか出ない。ここで通知しないと
      // 「放っておいたら終わっている」前提が崩れて、黙って止まったジョブに気づけなくなる。
      if (cur.status !== 'waiting_human' && (cur.engine === 'jd2' || cur.engine === 'browser')) {
        toast('PowerDowner: 人間の操作が必要です', `${cur.filename ?? cur.url}\n${detail}`, `human:${jobId}`);
      }
    } else if (!waiting && cur.status === 'waiting_human') {
      this.emit(this.db.patchJob(jobId, { status: 'downloading', meta: { humanDetail: '' } }));
    }
  };

  /** ブラウザで人間がダウンロードを開始した → aria2 に引き継ぐ */
  onHandoff = (jobId: string, resolved: ResolvedDownload): void => {
    this.handoff(jobId, resolved).catch((e) => this.onFailed(jobId, (e as Error).message));
  };

  private async handoff(jobId: string, resolved: ResolvedDownload): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) return;
    if (!this.aria2.available) throw new Error(`aria2 が利用できません: ${this.aria2.detail}`);
    const gid = await this.aria2.add({ ...job, engine: 'aria2' }, resolved);
    this.emit(this.db.patchJob(jobId, {
      status: 'downloading', engine: 'aria2', externalId: gid,
      filename: resolved.filename ?? job.filename,
      meta: { via: 'browser', humanDetail: '', detail: '' },
    }));
    log(`[queue] ブラウザから aria2 へ引き継ぎ: ${resolved.filename ?? resolved.url}`);
  }

  /** JD2 が扱えない人間判定に当たった → ブラウザ引き継ぎへ回す */
  onNeedsBrowser = (jobId: string, reason: string): void => {
    this.toBrowser(jobId, reason).catch((e) => this.onFailed(jobId, (e as Error).message));
  };

  private async toBrowser(jobId: string, reason: string): Promise<void> {
    const job = this.db.getJob(jobId);
    if (!job) return;
    if (!this.browser.available) {
      this.onFailed(jobId, `${reason}。ブラウザ引き継ぎが使えないため続行できません (${this.browser.detail})`);
      return;
    }
    await this.jd2.cancel(job);
    const next = this.db.patchJob(jobId, { status: 'downloading', engine: 'browser', externalId: null, speed: 0, meta: { route: 'browser', detail: '', humanDetail: '' } })!;
    this.emit(next);
    log(`[queue] JD2 → ブラウザ引き継ぎ: ${job.url} (${reason})`);
    await this.browser.add(next);
  }

  private emit(job: Job | null): void {
    if (job) bus.emit('job', job);
  }

  // ---- 投入 --------------------------------------------------------------

  /** 投入先のユーザーと保存先フォルダを確定する。決まらなければここで弾く */
  private resolveDest(userId: number, destDir?: string | null): { user: User; dest: string } {
    const user = this.db.getUser(userId);
    if (!user) throw new HttpError(400, 'ユーザーが存在しません');

    const override = (destDir ?? '').trim();
    const dest = override || user.defaultDir;
    if (!dest) {
      throw new HttpError(400, `ユーザー「${user.name}」の既定フォルダが未設定です。ユーザー設定で保存先を登録するか、投入時にフォルダを指定してください`);
    }
    if (!path.isAbsolute(dest)) throw new HttpError(400, `保存先は絶対パスで指定してください: ${dest}`);
    try {
      fs.mkdirSync(dest, { recursive: true });
    } catch (e) {
      throw new HttpError(400, `保存先フォルダを作成できません: ${dest} (${(e as Error).message})`);
    }
    return { user, dest };
  }

  private newJob(userId: number, url: string, dest: string, meta: Record<string, unknown>): Job {
    const ts = now();
    return {
      id: randomUUID().slice(0, 8),
      userId,
      url,
      destDir: dest,
      engine: null,
      status: 'queued',
      filename: null,
      bytesTotal: 0,
      bytesDone: 0,
      speed: 0,
      error: null,
      externalId: null,
      meta,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  add(input: AddInput): { jobs: Job[]; skipped: string[] } {
    const { user, dest } = this.resolveDest(input.userId, input.destDir);

    const seen = new Set<string>();
    const jobs: Job[] = [];
    const skipped: string[] = [];
    for (const raw of input.urls) {
      const url = raw.trim();
      if (!url) continue;
      if (seen.has(url)) { skipped.push(url); continue; }
      seen.add(url);
      if (!/^https?:\/\//i.test(url)) { skipped.push(url); continue; }
      const job = this.newJob(user.id, url, dest, {});
      this.db.insertJob(job);
      jobs.push(job);
      this.emit(job);
    }
    this.schedulePump();
    return { jobs, skipped };
  }

  /**
   * DryEyes からの投入。1 件 = 1 ファイルで、urls はその同一ファイルのミラー。
   * 台帳と突き合わせて、取得済みならスキップ、未完のジョブがあれば合流させる
   * (docs/ROADMAP.md 2 章)。
   */
  addItems(input: AddItemsInput): AddItemsResult {
    const { user, dest } = this.resolveDest(input.userId, input.destDir);

    const all = Array.isArray(input.items) ? input.items : [];
    const items = all.slice(0, MAX_ITEMS_PER_REQUEST);
    const truncated = all.length - items.length;
    if (truncated > 0) {
      log(`[queue] 投入が上限 ${MAX_ITEMS_PER_REQUEST} 件を超えたので ${truncated} 件を切り捨てました`);
    }

    const result: AddItemsResult = { created: [], merged: [], skipped: [], invalid: [], truncated };

    for (const item of items) {
      const meta = item.meta ?? {};
      const label = (meta.title ?? meta.rawText ?? null) as string | null;
      const sourceKey = item.sourceKey ?? null;

      // 同一ファイルのミラー。並び順がそのまま候補の優先順になる
      const urls: string[] = [];
      for (const raw of Array.isArray(item.urls) ? item.urls : []) {
        const url = String(raw ?? '').trim();
        if (!url || urls.includes(url)) continue;
        if (!/^https?:\/\//i.test(url)) continue;
        urls.push(url);
      }
      if (urls.length === 0) {
        result.invalid.push({ sourceKey, title: label, reason: '有効な URL がありません (http/https のみ)' });
        continue;
      }

      const decision = decideItem(this.db, user.id, item);

      // 黙って捨てると「新刊が出たのに落ちてこない」の切り分けができなくなるので必ず残す
      if (decision.kind === 'skip') {
        result.skipped.push({ sourceKey, title: label, reason: decision.reason });
        log(`[queue] スキップ: ${label ?? urls[0]} (${decision.reason})`);
        continue;
      }

      // 合流先が消えていた場合は new として落とす
      if (decision.kind === 'merge' && this.mergeIntoJob(decision.jobId, decision.item.id, urls, item.source ?? null)) {
        result.merged.push({ jobId: decision.jobId, sourceKey, title: label, urls });
        continue;
      }

      // 落としやすいところから試す。並べ替えるのはここ 1 か所だけで、
      // 以降は meta.mirrors の順に消化していく
      const ordered = sortByPriority(urls, this.cfg.mirrors.priority);
      const job = this.newJob(user.id, ordered[0], dest, {
        item: {
          title: meta.title ?? null,
          author: meta.author ?? null,
          volume: meta.volume ?? null,
          rawText: meta.rawText ?? null,
        },
        source: item.source ?? null,
        sourceKey,
        mirrors: ordered.slice(1),
        tried: [],
      });
      this.db.insertJob(job);

      const entry = this.db.insertItem({
        userId: user.id,
        seriesKey: decision.parsed.seriesKey,
        volumeFrom: decision.parsed.volumeFrom,
        volumeTo: decision.parsed.volumeTo,
        status: 'pending',
        title: (meta.title ?? null) as string | null,
        author: (meta.author ?? null) as string | null,
        jobId: job.id,
        source: item.source ?? null,
        rawText: (meta.rawText ?? null) as string | null,
      });
      const stored = this.db.patchJob(job.id, { meta: { itemId: entry.id } }) ?? job;

      result.created.push(stored);
      this.emit(stored);
    }

    this.schedulePump();
    return result;
  }

  /**
   * 別サイトから同じ巻が来た時に、既存ジョブのミラー候補として合流させる。
   * 失敗が確定していたジョブは候補が増えたので queued に戻す —
   * サイト A で詰まっていた巻がサイト B の出現で落ちるのはこの経路。
   * 合流先のジョブが消えていたら false を返し、呼び出し側で新規として落とす。
   */
  private mergeIntoJob(jobId: string, itemId: number, urls: string[], source: string | null): boolean {
    const job = this.db.getJob(jobId);
    if (!job) return false;

    const mirrors = Array.isArray(job.meta.mirrors) ? (job.meta.mirrors as string[]) : [];
    const tried = Array.isArray(job.meta.tried) ? (job.meta.tried as { url: string; error?: string }[]) : [];
    const known = new Set<string>([job.url, ...mirrors, ...tried.map((t) => t.url)]);
    const added = urls.filter((u) => !known.has(u));

    this.db.appendMerge(itemId, { source, urls, at: now() } as MergeRecord);

    if (added.length === 0) {
      log(`[queue] 合流 (新しい候補は無し): ${job.url}`);
      return true;
    }

    // 合流で増えた候補も含めて並べ直す。今試している url はそのまま (途中で乗り換えない)
    const nextMirrors = sortByPriority([...mirrors, ...added], this.cfg.mirrors.priority);
    const revive = job.status === 'failed' || job.status === 'canceled';
    const next = revive
      ? this.db.patchJob(jobId, {
          status: 'queued',
          url: nextMirrors[0],
          error: null,
          speed: 0,
          externalId: null,
          engine: null,
          meta: {
            mirrors: nextMirrors.slice(1),
            tried: [...tried, { url: job.url, error: job.error ?? '' }],
            detail: '',
            humanDetail: '',
            via: '',
            route: '',
          },
        })
      : this.db.patchJob(jobId, { meta: { mirrors: nextMirrors } });

    log(`[queue] 合流: ${job.url} に候補 ${added.length} 件を追加${revive ? ' (失敗していたので再開)' : ''}`);
    this.emit(next);
    if (revive) this.schedulePump();
    return true;
  }

  retry(id: string): Job {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (job.status !== 'failed' && job.status !== 'canceled') throw new HttpError(400, '失敗または中止したジョブのみ再試行できます');
    const next = this.db.patchJob(id, {
      status: 'queued', error: null, speed: 0, bytesDone: 0, externalId: null, engine: null,
      // route も消す。一度ブラウザへ回ったジョブが config を変えても
      // ブラウザに固定され続けるので、再試行では経路判定からやり直す
      meta: { detail: '', humanDetail: '', via: '', route: '' },
    });
    this.emit(next);
    this.schedulePump();
    return next!;
  }

  /** 人間待ちのジョブを、エンジン側のスキップ解除で再開させる */
  async resume(id: string): Promise<Job> {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (job.status !== 'waiting_human') throw new HttpError(400, '人間待ちのジョブのみ再開できます');
    if (job.engine !== 'jd2') throw new HttpError(400, 'このエンジンには再開操作がありません');
    await this.jd2.unskip(job);
    const next = this.db.patchJob(id, { status: 'downloading', meta: { humanDetail: '' } });
    this.emit(next);
    return next!;
  }

  async cancel(id: string): Promise<Job> {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (job.status === 'done' || job.status === 'failed' || job.status === 'canceled') return job;
    await this.detach(job);
    const next = this.db.patchJob(id, { status: 'canceled', speed: 0, meta: { humanDetail: '' } });
    this.emit(next);
    return next!;
  }

  async remove(id: string): Promise<void> {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (job.status === 'downloading' || job.status === 'waiting_human' || job.status === 'waiting_site' || job.status === 'resolving') {
      await this.detach(job);
    }
    this.db.deletePendingItemsByJob(id);
    this.db.deleteJob(id);
    bus.emit('jobRemoved', id);
  }

  private async detach(job: Job): Promise<void> {
    try {
      if (job.engine === 'aria2') await this.aria2.cancel(job);
      else if (job.engine === 'jd2') await this.jd2.cancel(job);
      else if (job.engine === 'browser') await this.browser.cancel(job);
    } catch (e) {
      log(`[queue] cancel error: ${(e as Error).message}`);
    }
  }

  // ---- 実行 --------------------------------------------------------------

  schedulePump(): void {
    if (this.pumping) { this.pumpAgain = true; return; }
    this.pump().catch((e) => log(`[queue] pump error: ${e}`));
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        for (const job of this.db.listJobsByStatus(['queued'])) {
          await this.dispatch(job);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async dispatch(job: Job): Promise<void> {
    this.emit(this.db.patchJob(job.id, { status: 'resolving', error: null }));
    try {
      const route = await this.router.resolve(job);
      if (route.engine === 'aria2') {
        if (!this.aria2.available) throw new Error(`aria2 が利用できません: ${this.aria2.detail}`);
        const r = route.resolved!;
        const gid = await this.aria2.add({ ...job, engine: 'aria2' }, r);
        this.emit(this.db.patchJob(job.id, {
          status: 'downloading', engine: 'aria2', externalId: gid,
          filename: r.filename ?? null, bytesTotal: r.bytesTotal ?? 0,
        }));
      } else if (route.engine === 'jd2') {
        if (!this.jd2.available) throw new Error(`JD2 が利用できません: ${this.jd2.detail}`);
        const ext = await this.jd2.add({ ...job, engine: 'jd2' });
        this.emit(this.db.patchJob(job.id, { status: 'downloading', engine: 'jd2', externalId: ext }));
      } else {
        if (!this.browser.available) throw new Error(`ブラウザが利用できません: ${this.browser.detail}`);
        // 自動操作が走る間は downloading。人間が必要になった時だけエンジン側が waiting_human に切り替える
        const next = this.db.patchJob(job.id, { status: 'downloading', engine: 'browser', meta: { route: 'browser' } })!;
        this.emit(next);
        await this.browser.add(next);
      }
      log(`[queue] 投入 (${route.engine}): ${job.url}`);
    } catch (e) {
      this.onFailed(job.id, (e as Error).message);
    }
  }

  /** 起動時: 前回の途中ジョブを復元する */
  async recover(): Promise<void> {
    for (const job of this.db.listJobsByStatus(['resolving'])) {
      this.emit(this.db.patchJob(job.id, { status: 'queued' }));
    }
    for (const job of this.db.listJobsByStatus(['downloading', 'waiting_human', 'waiting_site'])) {
      let ok = false;
      try {
        if (job.engine === 'aria2' && this.aria2.available) ok = await this.aria2.reattach(job);
        else if (job.engine === 'jd2') ok = await this.jd2.reattach(job);
        // browser はページが消えているので再投入 (meta.route で再びブラウザに向かう)
      } catch { ok = false; }
      if (!ok) {
        log(`[queue] 復元できないので再投入: ${job.url}`);
        this.emit(this.db.patchJob(job.id, { status: 'queued', externalId: null, engine: null, speed: 0, meta: { humanDetail: '', detail: '' } }));
      }
    }
    this.schedulePump();
  }
}
