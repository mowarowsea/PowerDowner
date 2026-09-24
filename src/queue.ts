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
import { decideItems, type ItemInput } from './library.js';
import { fitPath, planName, uniqueName, type NameInput } from './naming.js';
import { hostOf, pickFreeHostMirror, sortByPriority } from './mirrors.js';
import { hosterKeyOf, newHosterFor, priorityDomains, splitByEnabled } from './hosters.js';
import { bus, log } from './events.js';
import { toast } from './notify.js';
import { relToRoot, savePreview } from './models.js';

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

/** 「使用しない」設定のせいでジョブにしなかった URL */
export interface RejectedUrl {
  url: string;
  /** 画面に出す業者名 */
  hoster: string;
}

export interface AddResult {
  jobs: Job[];
  /** 空行・重複・http(s) 以外 */
  skipped: string[];
  rejected: RejectedUrl[];
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
  /**
   * 候補が「使用しない」アップローダばかりだったので登録しなかったもの。
   * skipped (もう持っている) と分けているのは、こちらは設定を戻せば落ちてくる —
   * 投入元に「取得済み」と誤解させると、二度と入ってこなくなる。
   */
  rejected: { sourceKey: string | null; title: string | null; reason: string; hosters: string[] }[];
  /** 上限で切り捨てた件数 */
  truncated: number;
}

/** 確認カードから投入する CivitAI の 1 セット (モデル + プレビュー画像) */
export interface AddCivitaiInput {
  userId: number;
  /** 保存先の絶対パス。カードで選んだフォルダを解決済みで渡す */
  dir: string;
  host: string;
  modelId: number;
  modelName: string;
  type: string;
  versionId: number;
  versionName: string;
  baseModel: string;
  fileId: number;
  fileName: string;
  bytes: number;
  /** 原寸の画像 URL。null なら画像は落とさない */
  imageUrl: string | null;
  thumb: string | null;
}

/** jobs.meta.civitai に焼く中身。落とす物を投入時に決めて、以後は動かさない */
export interface CivitaiMeta {
  modelId: number;
  modelName: string;
  type: string;
  versionId: number;
  versionName: string;
  baseModel: string;
  fileId: number;
  imageUrl: string | null;
  thumb: string | null;
}

/** jobs.meta.preview。モデルが落ちた後に付ける画像の状況 */
export interface PreviewMeta {
  state: 'pending' | 'saving' | 'ok' | 'failed' | 'none';
  file?: string;
  error?: string;
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

  // ---- アップローダの台帳 -------------------------------------------------

  /**
   * ミラーの並べ替えに使うドメインの列。
   * config.json ではなく DB の台帳が正 — 画面で並べ替えたものがすぐ効く。
   */
  private priorityDomains(): string[] {
    return priorityDomains(this.db.listHosters());
  }

  /** この URL がどの業者か。台帳に無ければ null (直リンクや CivitAI はここに来る) */
  private hosterKeyFor(url: string): string | null {
    return hosterKeyOf(url, this.db.listHosters());
  }

  /**
   * 実績を 1 つ記録する。
   *
   * 数える相手は必ず meta.hosterKey — job.url は途中で直リンク配信の CDN に化けるので
   * (frdl なら e21.urleecher.com)、url から引き直すと別のところに実績が付く。
   */
  private bump(job: Job, kind: 'ok' | 'fail' | 'human'): void {
    const key = typeof job.meta.hosterKey === 'string' ? job.meta.hosterKey : null;
    if (key) this.db.bumpHoster(key, kind);
  }

  /**
   * 台帳に無いドメインを行として起こす。
   *
   * 呼ぶのはワンクリックホスター経路 (JD2 / ブラウザ) に入った時だけ。投入のたびに
   * 起こすと、直リンクや CivitAI まで「アップローダ」として表に並んでしまう。
   * 既定は「使用する」なので、業者が新しいドメインに移っても止まらない。
   */
  private learnHoster(job: Job): string | null {
    const known = this.hosterKeyFor(job.url);
    if (known) return known;
    const def = newHosterFor(job.url);
    // 起こせないほど壊れた URL なら、投入時に決めた付け先をそのまま使う
    if (!def) return typeof job.meta.hosterKey === 'string' ? job.meta.hosterKey : null;
    const row = this.db.ensureHoster(def);
    log(`[hosters] 新しいアップローダを台帳に追加しました: ${row.label} (使用する / 優先度は最後)`);
    return row.key;
  }

  // ---- エンジンからのコールバック -----------------------------------------

  onProgress = (jobId: string, p: Progress): void => {
    const cur = this.db.getJob(jobId);
    if (!cur || (cur.status !== 'downloading' && cur.status !== 'waiting_human' && cur.status !== 'waiting_site')) return;
    const patch: Partial<Job> = { bytesTotal: p.bytesTotal, bytesDone: p.bytesDone, speed: p.speed };
    // 制限待ちが明けてエンジンが再び動き出した。downloading に戻さないと、
    // この先の人間待ち (onWaitingHuman) が状態の条件で弾かれて、黙って止まる
    if (cur.status === 'waiting_site' && !(Number(cur.meta.notBefore) > Date.now())) patch.status = 'downloading';
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

    // CivitAI のモデルは名前を変えない。元の名前がトリガーワードの手がかりになり、
    // 作品・巻の命名 (naming.ts) はそもそも当てはまらない
    const civitai = cur.meta.civitai as CivitaiMeta | undefined;
    const finalName = civitai ? name : verdict.path ? this.relocate(cur, verdict.path) : name;

    const job = this.db.patchJob(jobId, {
      status: 'done',
      filename: finalName,
      // 実ファイルの大きさが分かったならそれを正とする。エンジンによっては
      // 進捗を 1 度も報告しないまま終わるので、0 B のまま完了になってしまう
      bytesTotal: verdict.size > 0 ? verdict.size : cur.bytesTotal,
      bytesDone: verdict.size > 0 ? verdict.size
        : cur.bytesTotal > 0 ? cur.bytesTotal : cur.bytesDone,
      speed: 0,
      error: null,
      meta: { detail: '', humanDetail: '' },
    });
    // 実ファイルを確認した後にだけ数える。エンジンの「終わった」で数えると、
    // 0 バイトや HTML を掴まされたアップローダが優良に見えてしまう
    this.bump(cur, 'ok');

    // ジョブが done になった時点で「取得済み」の判定に参加する (src/library.ts)。
    // 棚 (pinax) に載るのは次のスキャンからなので、それまではこのジョブが弾く
    log(`[queue] 完了: ${job?.filename ?? cur.url} (${verdict.size} B)`);
    this.emit(job);

    // モデルが揃ってから画像を付ける。先に置くと、モデル側が同名回避で ` (2)` になった時に
    // 名前がずれて、Forge がプレビューとして拾わない
    if (civitai && job) this.attachPreview(job.id).catch((e) => log(`[queue] 画像の保存でエラー: ${(e as Error).message}`));
  };

  /**
   * CivitAI のジョブに、モデルと同じ名前のプレビュー画像を置く。
   *
   * **画像が駄目でもジョブは完了のまま。** 何 GB もあるモデルを画像 1 枚のために
   * 失敗扱いにしない。代わりに meta.preview に失敗を残し、画面から画像だけ取り直せるようにする。
   */
  private async attachPreview(jobId: string): Promise<void> {
    const job = this.db.getJob(jobId);
    const c = job?.meta.civitai as CivitaiMeta | undefined;
    if (!job || !c) return;
    if (!c.imageUrl) {
      this.emit(this.db.patchJob(jobId, { meta: { preview: { state: 'none' } satisfies PreviewMeta } }));
      return;
    }
    if (!job.filename) {
      this.emit(this.db.patchJob(jobId, { meta: { preview: { state: 'failed', error: 'モデルのファイル名が分からないので画像の名前を決められません' } satisfies PreviewMeta } }));
      return;
    }
    // 実ファイルの在りかを探す。aria2 は保存先の直下に置くので、まずそこを見る
    const modelPath = this.findDownloaded(job.destDir, job.filename);
    const dir = modelPath ? path.dirname(modelPath) : job.destDir;

    this.emit(this.db.patchJob(jobId, { meta: { preview: { state: 'saving' } satisfies PreviewMeta } }));
    try {
      const file = await savePreview(c.imageUrl, dir, job.filename);
      log(`[queue] 画像を保存: ${path.join(dir, file)}`);
      this.emit(this.db.patchJob(jobId, { meta: { preview: { state: 'ok', file } satisfies PreviewMeta } }));
    } catch (e) {
      const error = (e as Error).message;
      log(`[queue] 画像を保存できませんでした: ${job.filename} (${error})`);
      this.emit(this.db.patchJob(jobId, { meta: { preview: { state: 'failed', error } satisfies PreviewMeta } }));
    }
  }

  /** 画像だけ取り直す。モデルは落とし直さない */
  retryPreview(id: string): Job {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (!job.meta.civitai) throw new HttpError(400, 'CivitAI のジョブではありません');
    if (job.status !== 'done') throw new HttpError(400, 'モデルが落ち終わってから取り直してください');
    const next = this.db.patchJob(id, { meta: { preview: { state: 'pending' } satisfies PreviewMeta } });
    this.emit(next);
    this.attachPreview(id).catch((e) => log(`[queue] 画像の保存でエラー: ${(e as Error).message}`));
    return next!;
  }

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
  private verifyDownload(job: Job, filename: string | null): { ok: true; size: number; path: string | null } | { ok: false; reason: string } {
    const found = filename ? this.findDownloaded(job.destDir, filename) : null;

    if (found === null) {
      const reported = Math.max(job.bytesDone, job.bytesTotal);
      if (reported > 0) return { ok: true, size: 0, path: null };
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
    return { ok: true, size, path: found };
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

  /**
   * 落ちてきたファイルを `[著者] 作品名/[著者] 作品名 第nn巻.拡張子` へ移す。
   * 返すのは新しいファイル名 (画面と台帳に出す名前)。
   *
   * 作品名・巻数は台帳の行を正とし、無ければ投入メタ、それも無ければ元のファイル名から読む。
   * 読めなければ名前は変えない (`src/naming.ts`)。
   *
   * **失敗しても完了は完了。** ファイルはもう手元にあるので、名前が揃わないことより
   * 「落ちているのに失敗と言われる」ほうが困る。NAS の権限やパス長でここは普通に転ぶ。
   */
  private relocate(job: Job, filePath: string): string {
    const current = path.basename(filePath);
    if (!this.cfg.rename.enabled) return current;

    // 作品名と巻数は**投入時に読んだ解釈** (ジョブに焼いてある) を正とする。
    // 落ちてきたファイル名から読み直すと、URL 由来のゴミが作品名に混ざる
    const meta = (job.meta.item ?? {}) as { title?: string | null; author?: string | null };
    const input: NameInput = {
      author: meta.author ?? null,
      title: meta.title ?? null,
      volumeFrom: job.volumeFrom,
      volumeTo: job.volumeTo,
    };

    const plan = fitPath(job.destDir, planName(current, input, { folder: this.cfg.rename.folder }), input);
    const targetDir = plan.folder ? path.join(job.destDir, plan.folder) : job.destDir;

    try {
      // 既に正しい場所と名前なら何もしない。ここで uniqueName に渡すと
      // 自分自身とぶつかって ` (2)` が付いてしまう
      if (path.resolve(path.join(targetDir, plan.file)) === path.resolve(filePath)) return current;

      fs.mkdirSync(targetDir, { recursive: true });
      const finalName = uniqueName(targetDir, plan.file, (p) => fs.existsSync(p));
      fs.renameSync(filePath, path.join(targetDir, finalName));
      this.pruneEmptyDir(path.dirname(filePath), job.destDir);
      log(`[queue] 整理: ${current} -> ${path.join(plan.folder ?? '', finalName)}`);
      return finalName;
    } catch (e) {
      log(`[queue] 整理できませんでした (落ちた名前のまま置きます): ${current} (${(e as Error).message})`);
      return current;
    }
  }

  /** JD2 が掘ったパッケージフォルダなど、空になった 1 段を片付ける。保存先そのものは消さない */
  private pruneEmptyDir(dir: string, destDir: string): void {
    if (path.resolve(dir) === path.resolve(destDir)) return;
    try {
      if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    } catch { /* 消せないなら残しておけばよい。中身があるなら消してはいけない */ }
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

    // ここから先はこの候補を見限る。ミラーへ移ろうが失敗が確定しようが、
    // 「このアップローダでは落ちなかった」ことに変わりはないので 1 回だけ数える。
    // 台帳スキップ (もう持っている) はジョブにならないので、ここには来ない
    this.bump(cur, 'fail');

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
        // 別のアップローダへ移るので、実績の付け先と人間待ちの計上も引き継がない
        hosterKey: this.hosterKeyFor(next), humanCounted: false,
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
    const next = pickFreeHostMirror(mirrors, this.busyHosts(cur.id), this.priorityDomains());
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
        hosterKey: this.hosterKeyFor(next), humanCounted: false,
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

  /**
   * サイトの制限やサイト落ちで待たされる。まだ試していない候補があれば、待たずにそちらへ移す
   * (待ちが明けるのを繰り返し待つより、次の候補で落ちる方が早い)。
   * 移した候補は tried に落とす。末尾に回すと全候補が待ちのときに候補間を延々と巡回するため。
   * 最後の候補なら従来どおり待つ。移したら true を返し、エンジンはこのジョブを手放す
   */
  onSiteWait = (jobId: string, resumeAt: number, reason: string): boolean => {
    const cur = this.db.getJob(jobId);
    if (!cur) return false;
    // 待ちは失敗ではないので実績の fail には数えない
    if (this.toNextMirror(cur, `待ちになったので次の候補へ (${reason})`)) return true;

    const at = new Date(resumeAt);
    const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
    this.emit(this.db.patchJob(jobId, {
      status: 'waiting_site',
      speed: 0,
      meta: { notBefore: resumeAt, waitReason: reason, detail: `${hhmm} に自動で再開 (${reason})`, humanDetail: '' },
    }));
    return false;
  };

  onLinkIds = (jobId: string, linkIds: number[]): void => {
    this.emit(this.db.patchJob(jobId, { meta: { jd2LinkIds: linkIds } }));
  };

  onWaitingHuman = (jobId: string, waiting: boolean, detail: string): void => {
    const cur = this.db.getJob(jobId);
    if (!cur) return;
    if (waiting && (cur.status === 'downloading' || cur.status === 'waiting_human')) {
      if (cur.status !== 'waiting_human' || cur.meta.humanDetail !== detail) {
        // 人間待ちは 1 秒ごとに報告されるので、ジョブにつき 1 回だけ数える。
        // 数えたい実績は「何回呼び出されたか」ではなく「何件が人手を要したか」
        const first = cur.meta.humanCounted !== true;
        if (first) this.bump(cur, 'human');
        this.emit(this.db.patchJob(jobId, {
          status: 'waiting_human',
          meta: first ? { humanDetail: detail, humanCounted: true } : { humanDetail: detail },
        }));
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

  private newJob(
    userId: number,
    url: string,
    dest: string,
    meta: Record<string, unknown>,
    parsed: { seriesKey: string; volumeFrom: number | null; volumeTo: number | null } | null = null
  ): Job {
    const ts = now();
    // 実績の付け先はここで決めて動かさない。url は直リンクに差し替わることがある
    meta = { ...meta, hosterKey: this.hosterKeyFor(url) };
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
      // 「同じ巻が別サイトから来た」「落としたばかりでまだ棚に無い」を判定するための解釈。
      // 巻数を読めなかったものは null のままで、判定に参加しない
      seriesKey: parsed?.seriesKey || null,
      volumeFrom: parsed?.volumeFrom ?? null,
      volumeTo: parsed?.volumeTo ?? null,
      meta,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  add(input: AddInput): AddResult {
    const { user, dest } = this.resolveDest(input.userId, input.destDir);

    const seen = new Set<string>();
    const jobs: Job[] = [];
    const skipped: string[] = [];
    const rejected: RejectedUrl[] = [];
    const hosters = this.db.listHosters();
    for (const raw of input.urls) {
      const url = raw.trim();
      if (!url) continue;
      if (seen.has(url)) { skipped.push(url); continue; }
      seen.add(url);
      if (!/^https?:\/\//i.test(url)) { skipped.push(url); continue; }

      // 「使用しない」アップローダはジョブにしない。人間が手で貼った時も同じ扱いにする —
      // 例外を作ると、無操作で回すという設定の意味が薄れる (設定画面で戻せる)
      const [bad] = splitByEnabled([url], hosters).rejected;
      if (bad) {
        rejected.push({ url, hoster: bad.hoster });
        bus.emit('rejected', { hosters: [bad.hoster], label: url, source: 'ui' });
        log(`[queue] 使用しない設定なので登録しません: ${url} (${bad.hoster})`);
        continue;
      }

      const job = this.newJob(user.id, url, dest, {});
      this.db.insertJob(job);
      jobs.push(job);
      this.emit(job);
    }
    this.schedulePump();
    return { jobs, skipped, rejected };
  }

  /**
   * 確認カードからの CivitAI 投入。モデル 1 ファイル + プレビュー画像 1 枚で 1 ジョブ。
   * 同じファイルを落としている最中なら重ねない (完了済みは、消して入れ直したい場合があるので通す)。
   */
  addCivitai(input: AddCivitaiInput): Job {
    const user = this.db.getUser(input.userId);
    if (!user) throw new HttpError(400, 'ユーザーが存在しません');
    if (!path.isAbsolute(input.dir)) throw new HttpError(400, `保存先は絶対パスで指定してください: ${input.dir}`);
    try {
      fs.mkdirSync(input.dir, { recursive: true });
    } catch (e) {
      throw new HttpError(400, `保存先フォルダを作成できません: ${input.dir} (${(e as Error).message})`);
    }

    const active = this.db
      .listJobsByStatus(['queued', 'resolving', 'downloading', 'waiting_human', 'waiting_site'])
      .find((j) => {
        const c = j.meta.civitai as CivitaiMeta | undefined;
        return c && c.versionId === input.versionId && c.fileId === input.fileId;
      });
    if (active) throw new HttpError(409, `同じファイルを落としている最中です: ${active.filename ?? input.fileName}`);

    const url = `https://${input.host}/models/${input.modelId}?modelVersionId=${input.versionId}`;
    const civitai: CivitaiMeta = {
      modelId: input.modelId,
      modelName: input.modelName,
      type: input.type,
      versionId: input.versionId,
      versionName: input.versionName,
      baseModel: input.baseModel,
      fileId: input.fileId,
      imageUrl: input.imageUrl,
      thumb: input.thumb,
    };
    const job = this.newJob(user.id, url, input.dir, {
      civitai,
      preview: { state: input.imageUrl ? 'pending' : 'none' } satisfies PreviewMeta,
    });
    // 解決前から名前と大きさを出しておく。URL のままだと何のモデルか分からない
    job.filename = input.fileName;
    job.bytesTotal = input.bytes;
    this.db.insertJob(job);

    // 次のカードの初期値にする。根の中なら相対で覚えて、根を移しても効くようにする
    this.db.setSetting(`civitai_last_dir:${input.type.toLowerCase()}`, relToRoot(this.db.getSetting('civitai_models_root'), input.dir));

    log(`[queue] CivitAI: ${input.modelName} / ${input.versionName} -> ${input.dir}`);
    this.emit(job);
    this.schedulePump();
    return job;
  }

  /**
   * DryEyes からの投入。1 件 = 1 ファイルで、urls はその同一ファイルのミラー。
   * 棚 (pinax) に聞いて取得済みならスキップ、落とし中のジョブがあれば合流させる
   * (docs/ROADMAP.md 2.5)。
   */
  async addItems(input: AddItemsInput): Promise<AddItemsResult> {
    const { user, dest } = this.resolveDest(input.userId, input.destDir);

    const all = Array.isArray(input.items) ? input.items : [];
    const items = all.slice(0, MAX_ITEMS_PER_REQUEST);
    const truncated = all.length - items.length;
    if (truncated > 0) {
      log(`[queue] 投入が上限 ${MAX_ITEMS_PER_REQUEST} 件を超えたので ${truncated} 件を切り捨てました`);
    }

    const result: AddItemsResult = { created: [], merged: [], skipped: [], invalid: [], rejected: [], truncated };
    const hosters = this.db.listHosters();
    /** 同じ投入の中で合流させるための対応。投入の index → 作ったジョブ */
    const createdIds = new Map<number, string>();

    // 所持の判定はまとめて 1 回で聞く。20 件の投入で棚を 20 回叩く理由が無い。
    // URL が無効な件も混ざるが、聞く相手が増えるわけではないので選り分けない
    const decisions = await decideItems(this.db, this.cfg.pinax, user.id, items);

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
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

      const decision = decisions[index];

      // 黙って捨てると「新刊が出たのに落ちてこない」の切り分けができなくなるので必ず残す
      if (decision.kind === 'skip') {
        result.skipped.push({ sourceKey, title: label, reason: decision.reason });
        log(`[queue] スキップ: ${label ?? urls[0]} (${decision.reason})`);
        continue;
      }

      // 「使用しない」アップローダの候補を落とす。一部だけ無効なら残りで回す —
      // ここで item ごと捨てると、katfile を切った途端に katfile も載っている巻が
      // まるごと落ちてこなくなる
      const { usable, rejected } = splitByEnabled(urls, hosters);
      if (usable.length === 0) {
        const names = [...new Set(rejected.map((r) => r.hoster))];
        const reason = `使用しない設定のアップローダだけでした (${names.join(', ')})`;
        result.rejected.push({ sourceKey, title: label, reason, hosters: names });
        bus.emit('rejected', { hosters: names, label, source: 'items' });
        log(`[queue] 登録しません: ${label ?? urls[0]} (${reason})`);
        continue;
      }

      // 合流先が消えていた場合は new として落とす。mergeBatch は同じ投入の中の
      // 先行 1 件が相手なので、それが URL 無効などで作られていなければ同じく new
      const mergeTo =
        decision.kind === 'merge'
          ? decision.jobId
          : decision.kind === 'mergeBatch'
            ? createdIds.get(decision.index) ?? null
            : null;
      if (mergeTo && this.mergeIntoJob(mergeTo, usable, item.source ?? null)) {
        result.merged.push({ jobId: mergeTo, sourceKey, title: label, urls: usable });
        continue;
      }

      // 落としやすいところから試す。並べ替えるのはここ 1 か所だけで、
      // 以降は meta.mirrors の順に消化していく
      const ordered = sortByPriority(usable, this.priorityDomains());
      const job = this.newJob(
        user.id,
        ordered[0],
        dest,
        {
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
        },
        decision.parsed
      );
      this.db.insertJob(job);
      createdIds.set(index, job.id);

      result.created.push(job);
      this.emit(job);
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
  private mergeIntoJob(jobId: string, urls: string[], source: string | null): boolean {
    const job = this.db.getJob(jobId);
    if (!job) return false;

    const mirrors = Array.isArray(job.meta.mirrors) ? (job.meta.mirrors as string[]) : [];
    const tried = Array.isArray(job.meta.tried) ? (job.meta.tried as { url: string; error?: string }[]) : [];
    const known = new Set<string>([job.url, ...mirrors, ...tried.map((t) => t.url)]);
    const added = urls.filter((u) => !known.has(u));

    // どこから同じ巻が来たかの記録。台帳が無くなったので、残す場所はジョブ自身
    const mergedFrom: MergeRecord[] = [
      ...(Array.isArray(job.meta.mergedFrom) ? (job.meta.mergedFrom as MergeRecord[]) : []),
      { source, urls, at: now() },
    ];

    if (added.length === 0) {
      this.db.patchJob(jobId, { meta: { mergedFrom } });
      log(`[queue] 合流 (新しい候補は無し): ${job.url}`);
      return true;
    }

    // 合流で増えた候補も含めて並べ直す。今試している url はそのまま (途中で乗り換えない)
    const nextMirrors = sortByPriority([...mirrors, ...added], this.priorityDomains());
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
            mergedFrom,
            mirrors: nextMirrors.slice(1),
            tried: [...tried, { url: job.url, error: job.error ?? '' }],
            hosterKey: this.hosterKeyFor(nextMirrors[0]),
            humanCounted: false,
            detail: '',
            humanDetail: '',
            via: '',
            route: '',
          },
        })
      : this.db.patchJob(jobId, { meta: { mergedFrom, mirrors: nextMirrors } });

    log(`[queue] 合流: ${job.url} に候補 ${added.length} 件を追加${revive ? ' (失敗していたので再開)' : ''}`);
    this.emit(next);
    if (revive) this.schedulePump();
    return true;
  }

  /**
   * ジョブを最初からやり直す。
   *
   * 見限った候補 (meta.tried) も含めて全部の URL を集め直し、優先度順に並べ直してから
   * 先頭を今の候補にする — 「この 1 サイトをもう一度」ではなく「このジョブの候補を
   * 全部まっさらにして最初から」。時間を置けば直っている失敗 (サイト側の 5xx、
   * 一時的な人間待ち、同時ダウンロード数の上限) が多く、1 件目から試し直すほうが
   * 落ちる見込みが高い。台帳の実績は失敗した時点で数え済みなので、ここでは数えない。
   */
  retry(id: string): Job {
    const job = this.db.getJob(id);
    if (!job) throw new HttpError(404, 'ジョブがありません');
    if (job.status !== 'failed' && job.status !== 'canceled') throw new HttpError(400, '失敗または中止したジョブのみ再試行できます');

    const mirrors = Array.isArray(job.meta.mirrors) ? (job.meta.mirrors as string[]) : [];
    const tried = Array.isArray(job.meta.tried) ? (job.meta.tried as { url?: string }[]) : [];
    // 並びは tried → 今の url → mirrors。ミラー切替で消化した順そのままなので、
    // 優先度が同じものは元の順番を保ったまま並べ直せる
    const all: string[] = [];
    for (const u of [...tried.map((t) => String(t?.url ?? '')), job.url, ...mirrors]) {
      if (u && !all.includes(u)) all.push(u);
    }
    const ordered = sortByPriority(all, this.priorityDomains());
    const first = ordered[0] ?? job.url;

    const next = this.db.patchJob(id, {
      status: 'queued', url: first, error: null, speed: 0, externalId: null, engine: null,
      // 別の候補から取り直すかもしれないので、前回の進捗と名前は捨てる
      filename: null, bytesTotal: 0, bytesDone: 0,
      meta: {
        mirrors: ordered.slice(1),
        tried: [],
        hosterKey: this.hosterKeyFor(first), humanCounted: false,
        // route も消す。一度ブラウザへ回ったジョブが config を変えても
        // ブラウザに固定され続けるので、再試行では経路判定からやり直す
        detail: '', humanDetail: '', via: '', route: '', browserDirect: false,
      },
    });
    log(`[queue] 再試行 (候補 ${ordered.length} 件を最初から): ${first}`);
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
    // ジョブを消せばその巻は判定から外れる = また落とせる。
    // 台帳の頃に要った「完走していない行を道連れに消す」後始末はもう無い
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
        // ワンクリックホスター経路に入った = アップローダだと分かった。まだ台帳に無ければ起こす
        const ext = await this.jd2.add({ ...job, engine: 'jd2' });
        this.emit(this.db.patchJob(job.id, {
          status: 'downloading', engine: 'jd2', externalId: ext,
          meta: { hosterKey: this.learnHoster(job) },
        }));
      } else {
        if (!this.browser.available) throw new Error(`ブラウザが利用できません: ${this.browser.detail}`);
        // 自動操作が走る間は downloading。人間が必要になった時だけエンジン側が waiting_human に切り替える
        const next = this.db.patchJob(job.id, {
          status: 'downloading', engine: 'browser',
          meta: { route: 'browser', hosterKey: this.learnHoster(job) },
        })!;
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
