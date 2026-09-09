import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobPatch, User, JobStatus, Engine, LibraryItem, ItemStatus, MergeRecord } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  default_dir TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  url TEXT NOT NULL,
  dest_dir TEXT NOT NULL,
  engine TEXT,
  status TEXT NOT NULL,
  filename TEXT,
  bytes_total INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  speed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  external_id TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- 取得済みアイテムの台帳。別サイトの監視から同じ巻が来た時に「もう持っている」と
-- 判断するために使う。job_id をあえて外部キーにしていないのは、ジョブを消しても
-- 所持情報を残すため (docs/ROADMAP.md 2 章)。
--
-- 台帳はユーザー単位。保存先フォルダがユーザーごとに分かれている以上、
-- 「持っている」もユーザーごとにしか成り立たない — 共有にすると、先に誰かが落とした
-- 時点で 2 人目の手元には何も残らないまま弾かれる。
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  series_key TEXT NOT NULL,
  volume_from INTEGER,
  volume_to INTEGER,
  status TEXT NOT NULL,
  title TEXT,
  author TEXT,
  job_id TEXT,
  source TEXT,
  raw_text TEXT,
  merged_from TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS items_series_idx ON items(user_id, series_key, volume_from, volume_to);
CREATE INDEX IF NOT EXISTS items_job_idx ON items(job_id);
`;

type UserRow = { id: number; name: string; default_dir: string | null; created_at: string };
type JobRow = {
  id: string; user_id: number; url: string; dest_dir: string; engine: string | null; status: string;
  filename: string | null; bytes_total: number; bytes_done: number; speed: number; error: string | null;
  external_id: string | null; meta: string; created_at: string; updated_at: string;
};

function rowToUser(r: UserRow): User {
  return { id: r.id, name: r.name, defaultDir: r.default_dir, createdAt: r.created_at };
}

function rowToJob(r: JobRow): Job {
  return {
    id: r.id,
    userId: r.user_id,
    url: r.url,
    destDir: r.dest_dir,
    engine: (r.engine as Engine | null) ?? null,
    status: r.status as JobStatus,
    filename: r.filename,
    bytesTotal: Number(r.bytes_total),
    bytesDone: Number(r.bytes_done),
    speed: Number(r.speed),
    error: r.error,
    externalId: r.external_id,
    meta: safeJson(r.meta),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}

type ItemRow = {
  id: number; series_key: string; volume_from: number | null; volume_to: number | null;
  user_id: number;
  status: string; title: string | null; author: string | null; job_id: string | null;
  source: string | null; raw_text: string | null; merged_from: string;
  created_at: string; updated_at: string;
};

function rowToItem(r: ItemRow): LibraryItem {
  let merged: MergeRecord[] = [];
  try {
    const parsed = JSON.parse(r.merged_from);
    if (Array.isArray(parsed)) merged = parsed as MergeRecord[];
  } catch { merged = []; }
  return {
    id: r.id,
    userId: Number(r.user_id),
    seriesKey: r.series_key,
    volumeFrom: r.volume_from === null ? null : Number(r.volume_from),
    volumeTo: r.volume_to === null ? null : Number(r.volume_to),
    status: r.status as ItemStatus,
    title: r.title,
    author: r.author,
    jobId: r.job_id,
    source: r.source,
    rawText: r.raw_text,
    mergedFrom: merged,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const now = (): string => new Date().toISOString();

export class Db {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, 'powerdowner.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.migrateItemsToPerUser();
  }

  /**
   * 台帳をユーザー単位にする前の DB を引き上げる。
   *
   * 既存行の持ち主は、ジョブが残っていればそのジョブのユーザー。
   * 手で登録した所持記録 (job_id が無い) は手がかりが無いので最初のユーザーに寄せる —
   * 共有台帳だった頃は実質 1 人で使っていたはずで、間違えても「もう一度落ちる」だけ。
   *
   * ALTER TABLE では NOT NULL の列を後から足せないので作り直す。
   */
  private migrateItemsToPerUser(): void {
    const cols = this.db.prepare('PRAGMA table_info(items)').all() as { name: string }[];
    if (cols.length === 0 || cols.some((c) => c.name === 'user_id')) return;

    const before = (this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;

    // 作り直しの間だけ外部キーを外す。引き継ぐ行は既に検証済みで、
    // 次の起動で PRAGMA foreign_keys = ON の下を通る
    this.db.exec('PRAGMA foreign_keys = OFF;');
    try {
      this.db.exec(`
        BEGIN;
        CREATE TABLE items_migrating (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          series_key TEXT NOT NULL,
          volume_from INTEGER,
          volume_to INTEGER,
          status TEXT NOT NULL,
          title TEXT,
          author TEXT,
          job_id TEXT,
          source TEXT,
          raw_text TEXT,
          merged_from TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO items_migrating
          (id, user_id, series_key, volume_from, volume_to, status, title, author, job_id, source, raw_text, merged_from, created_at, updated_at)
        SELECT i.id, COALESCE(j.user_id, (SELECT MIN(id) FROM users)),
               i.series_key, i.volume_from, i.volume_to, i.status, i.title, i.author,
               i.job_id, i.source, i.raw_text, i.merged_from, i.created_at, i.updated_at
          FROM items i LEFT JOIN jobs j ON j.id = i.job_id
         WHERE COALESCE(j.user_id, (SELECT MIN(id) FROM users)) IS NOT NULL;
        DROP TABLE items;
        ALTER TABLE items_migrating RENAME TO items;
        COMMIT;
      `);
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
    // テーブルごと消えた索引を張り直す
    this.db.exec(SCHEMA);

    const after = (this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
    const lost = before - after;
    console.log(
      `[db] 台帳をユーザー単位に移行しました (${after} 件)` +
        (lost > 0 ? ` — ユーザーのいない ${lost} 件は引き継げませんでした` : '')
    );
  }

  // ---- users -------------------------------------------------------------
  listUsers(): User[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY id').all() as UserRow[]).map(rowToUser);
  }

  getUser(id: number): User | null {
    const r = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return r ? rowToUser(r) : null;
  }

  createUser(name: string, defaultDir: string | null): User {
    const r = this.db
      .prepare('INSERT INTO users (name, default_dir, created_at) VALUES (?, ?, ?) RETURNING *')
      .get(name, defaultDir, now()) as UserRow;
    return rowToUser(r);
  }

  updateUser(id: number, patch: { name?: string; defaultDir?: string | null }): User | null {
    const cur = this.getUser(id);
    if (!cur) return null;
    const name = patch.name ?? cur.name;
    const dir = patch.defaultDir === undefined ? cur.defaultDir : patch.defaultDir;
    this.db.prepare('UPDATE users SET name = ?, default_dir = ? WHERE id = ?').run(name, dir, id);
    return this.getUser(id);
  }

  deleteUser(id: number): boolean {
    const n = this.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?').get(id) as { n: number };
    if (n.n > 0) throw new Error('このユーザーにはジョブが残っているため削除できません');
    // 台帳はジョブを消しても残るが、持ち主がいなくなれば意味を失う。
    // ここで落とさないと、一度でも落としたユーザーは二度と消せなくなる
    this.db.prepare('DELETE FROM items WHERE user_id = ?').run(id);
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }

  // ---- jobs --------------------------------------------------------------
  listJobs(opts: { userId?: number; limit?: number } = {}): Job[] {
    const limit = opts.limit ?? 300;
    const rows = opts.userId === undefined
      ? this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit)
      : this.db.prepare('SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?').all(opts.userId, limit);
    return (rows as JobRow[]).map(rowToJob);
  }

  listJobsByStatus(statuses: JobStatus[]): Job[] {
    const marks = statuses.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE status IN (${marks}) ORDER BY created_at ASC`).all(...statuses);
    return (rows as JobRow[]).map(rowToJob);
  }

  getJob(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return r ? rowToJob(r) : null;
  }

  insertJob(job: Job): void {
    this.db.prepare(`INSERT INTO jobs
      (id, user_id, url, dest_dir, engine, status, filename, bytes_total, bytes_done, speed, error, external_id, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.userId, job.url, job.destDir, job.engine, job.status, job.filename, job.bytesTotal,
        job.bytesDone, job.speed, job.error, job.externalId, JSON.stringify(job.meta), job.createdAt, job.updatedAt);
  }

  patchJob(id: string, patch: JobPatch): Job | null {
    const cur = this.getJob(id);
    if (!cur) return null;
    const next: Job = { ...cur, ...patch, meta: { ...cur.meta, ...(patch.meta ?? {}) }, updatedAt: now() };
    this.db.prepare(`UPDATE jobs SET user_id=?, url=?, dest_dir=?, engine=?, status=?, filename=?, bytes_total=?,
      bytes_done=?, speed=?, error=?, external_id=?, meta=?, updated_at=? WHERE id=?`)
      .run(next.userId, next.url, next.destDir, next.engine, next.status, next.filename, next.bytesTotal,
        next.bytesDone, next.speed, next.error, next.externalId, JSON.stringify(next.meta), next.updatedAt, id);
    return next;
  }

  deleteJob(id: string): boolean {
    return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
  }

  // ---- library (取得済みアイテムの台帳) -----------------------------------

  /**
   * 巻数の範囲が重なる既存アイテムを返す。
   * 「1-6 巻を持っている状態で 3 巻が来た」を捕まえるのがこのクエリ。
   * 巻数を読めなかったアイテム (volume_from IS NULL) は判定に参加しない。
   */
  findOverlappingItems(userId: number, seriesKey: string, from: number, to: number): LibraryItem[] {
    const rows = this.db.prepare(
      `SELECT * FROM items
        WHERE user_id = ? AND series_key = ?
          AND volume_from IS NOT NULL AND volume_to IS NOT NULL
          AND volume_from <= ? AND volume_to >= ?
        ORDER BY id`
    ).all(userId, seriesKey, to, from);
    return (rows as ItemRow[]).map(rowToItem);
  }

  getItem(id: number): LibraryItem | null {
    const r = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow | undefined;
    return r ? rowToItem(r) : null;
  }

  findItemByJob(jobId: string): LibraryItem | null {
    const r = this.db.prepare('SELECT * FROM items WHERE job_id = ? ORDER BY id LIMIT 1').get(jobId) as ItemRow | undefined;
    return r ? rowToItem(r) : null;
  }

  listItems(opts: { userId?: number; seriesKey?: string; limit?: number } = {}): LibraryItem[] {
    const limit = opts.limit ?? 500;
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.userId !== undefined) { where.push('user_id = ?'); args.push(opts.userId); }
    if (opts.seriesKey !== undefined) { where.push('series_key = ?'); args.push(opts.seriesKey); }
    const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM items${clause} ORDER BY series_key, volume_from, id LIMIT ?`)
      .all(...args, limit);
    return (rows as ItemRow[]).map(rowToItem);
  }

  insertItem(input: {
    userId: number;
    seriesKey: string;
    volumeFrom: number | null;
    volumeTo: number | null;
    status: ItemStatus;
    title?: string | null;
    author?: string | null;
    jobId?: string | null;
    source?: string | null;
    rawText?: string | null;
  }): LibraryItem {
    const ts = now();
    const r = this.db.prepare(
      `INSERT INTO items
        (user_id, series_key, volume_from, volume_to, status, title, author, job_id, source, raw_text, merged_from, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?) RETURNING *`
    ).get(
      input.userId, input.seriesKey, input.volumeFrom, input.volumeTo, input.status,
      input.title ?? null, input.author ?? null, input.jobId ?? null,
      input.source ?? null, input.rawText ?? null, ts, ts
    ) as ItemRow;
    return rowToItem(r);
  }

  patchItem(id: number, patch: {
    status?: ItemStatus; jobId?: string | null; title?: string | null; author?: string | null;
    seriesKey?: string; volumeFrom?: number | null; volumeTo?: number | null;
  }): LibraryItem | null {
    const cur = this.getItem(id);
    if (!cur) return null;
    const status = patch.status ?? cur.status;
    const jobId = patch.jobId === undefined ? cur.jobId : patch.jobId;
    const title = patch.title === undefined ? cur.title : patch.title;
    const author = patch.author === undefined ? cur.author : patch.author;
    // series_key と巻数まで書き換えられるのは管理画面から直す時だけ。
    // タイトルを直してもキーが元のままだと、直したつもりで何も変わらない
    const seriesKey = patch.seriesKey ?? cur.seriesKey;
    const from = patch.volumeFrom === undefined ? cur.volumeFrom : patch.volumeFrom;
    const to = patch.volumeTo === undefined ? cur.volumeTo : patch.volumeTo;
    this.db.prepare('UPDATE items SET status=?, job_id=?, title=?, author=?, series_key=?, volume_from=?, volume_to=?, updated_at=? WHERE id=?')
      .run(status, jobId, title, author, seriesKey, from, to, now(), id);
    return this.getItem(id);
  }

  /**
   * 同じ作品の行をまとめて付け替える。
   *
   * series_key はタイトルから導くので、作品名を入れ直すと**散らばっていたキーが 1 つに集まる**。
   * 作品名の分からないまま投入されて、生の文字列 (ミラーのホスト名まで含む) からキーが
   * 作られてしまった行を救う道がこれ — 1 行ずつ直すと、直した分から別のキーへ移ってしまう。
   */
  relabelSeries(userId: number, seriesKey: string, next: { seriesKey: string; title: string; author: string | null }): number {
    const r = this.db
      .prepare('UPDATE items SET series_key=?, title=?, author=?, updated_at=? WHERE user_id=? AND series_key=?')
      .run(next.seriesKey, next.title, next.author, now(), userId, seriesKey);
    return Number(r.changes);
  }

  /** 合流の記録を積む。どのサイトから同じ巻が来たかを後から追えるようにする */
  appendMerge(id: number, record: MergeRecord): LibraryItem | null {
    const cur = this.getItem(id);
    if (!cur) return null;
    const merged = [...cur.mergedFrom, record];
    this.db.prepare('UPDATE items SET merged_from=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(merged), now(), id);
    return this.getItem(id);
  }

  deleteItem(id: number): boolean {
    return this.db.prepare('DELETE FROM items WHERE id = ?').run(id).changes > 0;
  }

  /** まとめて消す。1 作品ぶんの行を片付けるのに 1 行ずつ叩かせない */
  deleteItems(ids: number[]): number {
    if (ids.length === 0) return 0;
    const marks = ids.map(() => '?').join(',');
    return Number(this.db.prepare(`DELETE FROM items WHERE id IN (${marks})`).run(...ids).changes);
  }

  /** ジョブを消した時の後始末。完走していない台帳は所持の証拠にならないので落とす */
  deletePendingItemsByJob(jobId: string): number {
    return Number(this.db.prepare("DELETE FROM items WHERE job_id = ? AND status = 'pending'").run(jobId).changes);
  }

  // ---- settings ----------------------------------------------------------
  getSetting(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setSetting(key: string, value: string | null): void {
    if (value === null || value === '') {
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    }
  }
}
