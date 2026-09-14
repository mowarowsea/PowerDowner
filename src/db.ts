import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Job, JobPatch, User, JobStatus, Engine, Hoster, HosterDef } from './types.js';

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
  -- 投入時に読んだ「どの作品の何巻か」。**取得済みの台帳はもう持たない** ので、
  -- 「同じ巻が別サイトから来た」「落としたばかりでまだ棚に無い」の判定はここでやる。
  -- 手元に何があるかは pinax が棚を見て答える (docs/ROADMAP.md 2.5)。
  series_key TEXT,
  volume_from INTEGER,
  volume_to INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_user_idx ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
-- jobs_series_idx は migrateItemsToJobs が張る。**ここに書いてはいけない** —
-- SCHEMA は series_key をまだ持たない古い DB にも流れるので、no such column で起動できなくなる
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- アップローダ (ホスター) の台帳。1 行 = 1 業者で、別名ドメインは domains にまとめる。
-- ユーザー単位にしないのは、サイトが CAPTCHA を出すかどうかが誰のジョブかに依らないため。
CREATE TABLE IF NOT EXISTS hosters (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  domains TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  ok_count INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  human_count INTEGER NOT NULL DEFAULT 0,
  last_ok_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

type UserRow = { id: number; name: string; default_dir: string | null; created_at: string };
type JobRow = {
  id: string; user_id: number; url: string; dest_dir: string; engine: string | null; status: string;
  filename: string | null; bytes_total: number; bytes_done: number; speed: number; error: string | null;
  external_id: string | null; series_key: string | null; volume_from: number | null; volume_to: number | null;
  meta: string; created_at: string; updated_at: string;
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
    seriesKey: r.series_key,
    volumeFrom: r.volume_from === null ? null : Number(r.volume_from),
    volumeTo: r.volume_to === null ? null : Number(r.volume_to),
    meta: safeJson(r.meta),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeJson(s: string): Record<string, unknown> {
  try { return JSON.parse(s) ?? {}; } catch { return {}; }
}

type HosterRow = {
  key: string; label: string; domains: string; enabled: number; priority: number;
  ok_count: number; fail_count: number; human_count: number; last_ok_at: string | null;
  created_at: string; updated_at: string;
};

function rowToHoster(r: HosterRow): Hoster {
  let domains: string[] = [];
  try {
    const parsed = JSON.parse(r.domains);
    if (Array.isArray(parsed)) domains = parsed.map(String);
  } catch { domains = []; }
  return {
    key: r.key,
    label: r.label,
    domains,
    enabled: r.enabled !== 0,
    priority: Number(r.priority),
    okCount: Number(r.ok_count),
    failCount: Number(r.fail_count),
    humanCount: Number(r.human_count),
    lastOkAt: r.last_ok_at,
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
    this.migrateItemsToJobs();
  }

  /**
   * 取得済みの台帳 (items) を捨てて、巻の判定を jobs に移した時の引き上げ。
   *
   * **台帳が持っていた「もう持っている」は pinax が棚を見て答える。** 台帳は
   * ダウンロードの記録であって棚の姿ではないので、手で置いたもの・落とす前から
   * 持っていたもの・消したものが映らなかった (docs/ROADMAP.md 2.5)。
   *
   * ただし台帳には所持以外にもう 1 つ仕事があった — 「今落としている最中の巻」の
   * 見張りで、**これは棚を見ても分からない** (まだファイルが無い)。そちらは
   * jobs の列へ引き継ぐ。捨てる前に、ジョブに結び付いていた行から巻の解釈を移す。
   */
  private migrateItemsToJobs(): void {
    const jobCols = this.db.prepare('PRAGMA table_info(jobs)').all() as { name: string }[];
    if (!jobCols.some((c) => c.name === 'series_key')) {
      this.db.exec(
        'ALTER TABLE jobs ADD COLUMN series_key TEXT;' +
        'ALTER TABLE jobs ADD COLUMN volume_from INTEGER;' +
        'ALTER TABLE jobs ADD COLUMN volume_to INTEGER;'
      );
      if (this.hasTable('items')) {
        // 台帳の解釈をそのまま移す。ここを飛ばすと、落とし中のジョブが判定から
        // 外れて、同じ巻が別サイトから来た時に二重に落ちる
        const moved = this.db.prepare(
          `UPDATE jobs SET
              series_key  = (SELECT i.series_key  FROM items i WHERE i.job_id = jobs.id ORDER BY i.id LIMIT 1),
              volume_from = (SELECT i.volume_from FROM items i WHERE i.job_id = jobs.id ORDER BY i.id LIMIT 1),
              volume_to   = (SELECT i.volume_to   FROM items i WHERE i.job_id = jobs.id ORDER BY i.id LIMIT 1)
            WHERE EXISTS (SELECT 1 FROM items i WHERE i.job_id = jobs.id)`
        ).run();
        console.log(`[db] 巻の判定を台帳から jobs へ移しました (${Number(moved.changes)} 件)`);
      }
    }
    // 列が揃ってから張る (新しい DB では SCHEMA が列を作り、ここで索引が付く)
    this.db.exec('CREATE INDEX IF NOT EXISTS jobs_series_idx ON jobs(user_id, series_key, volume_from, volume_to);');

    if (this.hasTable('items')) {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
      this.db.exec('DROP TABLE items;');
      console.log(`[db] 取得済みの台帳 (items ${n} 件) を捨てました — 所持は pinax の棚に聞きます`);
    }
  }

  private hasTable(name: string): boolean {
    return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
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
      (id, user_id, url, dest_dir, engine, status, filename, bytes_total, bytes_done, speed, error, external_id,
       series_key, volume_from, volume_to, meta, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.userId, job.url, job.destDir, job.engine, job.status, job.filename, job.bytesTotal,
        job.bytesDone, job.speed, job.error, job.externalId,
        job.seriesKey, job.volumeFrom, job.volumeTo, JSON.stringify(job.meta), job.createdAt, job.updatedAt);
  }

  patchJob(id: string, patch: JobPatch): Job | null {
    const cur = this.getJob(id);
    if (!cur) return null;
    const next: Job = { ...cur, ...patch, meta: { ...cur.meta, ...(patch.meta ?? {}) }, updatedAt: now() };
    this.db.prepare(`UPDATE jobs SET user_id=?, url=?, dest_dir=?, engine=?, status=?, filename=?, bytes_total=?,
      bytes_done=?, speed=?, error=?, external_id=?, series_key=?, volume_from=?, volume_to=?, meta=?, updated_at=? WHERE id=?`)
      .run(next.userId, next.url, next.destDir, next.engine, next.status, next.filename, next.bytesTotal,
        next.bytesDone, next.speed, next.error, next.externalId,
        next.seriesKey, next.volumeFrom, next.volumeTo, JSON.stringify(next.meta), next.updatedAt, id);
    return next;
  }

  deleteJob(id: string): boolean {
    return this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes > 0;
  }

  /**
   * 同じ巻を指す既存のジョブを返す。**台帳の代わりにここを見る。**
   *
   * 見るのは「まだ落としている最中」と「落とし終わった」だけで、失敗・中止は
   * 参加させない — 落とし直せないと困るし、台帳の頃に踏んだ
   * 「pending の行がジョブより長生きして、その巻の投入が全部吸い込まれる」壊れ方が
   * これで構造から消える。**落とし直したい時はジョブを消せばよい。**
   *
   * 落とし終わったジョブも見るのは、**棚 (pinax) に載るまでに間がある**ため。
   * スキャンは 3 時間おきなので、その間に同じ巻が別サイトから来ると二重に落ちる。
   * 棚に載った後は pinax も同じ答えを返すので、二重に持っていても害は無い。
   */
  findOverlappingJobs(userId: number, seriesKey: string, from: number, to: number): Job[] {
    const rows = this.db.prepare(
      `SELECT * FROM jobs
        WHERE user_id = ? AND series_key = ?
          AND status NOT IN ('failed', 'canceled')
          AND volume_from IS NOT NULL AND volume_to IS NOT NULL
          AND volume_from <= ? AND volume_to >= ?
        ORDER BY created_at`
    ).all(userId, seriesKey, to, from);
    return (rows as JobRow[]).map(rowToJob);
  }

  // ---- hosters (アップローダの台帳) ---------------------------------------

  listHosters(): Hoster[] {
    const rows = this.db.prepare('SELECT * FROM hosters ORDER BY priority ASC, key ASC').all() as HosterRow[];
    return rows.map(rowToHoster);
  }

  getHoster(key: string): Hoster | null {
    const r = this.db.prepare('SELECT * FROM hosters WHERE key = ?').get(key) as HosterRow | undefined;
    return r ? rowToHoster(r) : null;
  }

  /**
   * 無ければ作る。既にあれば domains に足りないドメインだけ足して返す。
   * 「frdl が frdl.xyz を使い始めた」を同じ行に吸収するのがここ。
   */
  ensureHoster(def: HosterDef): Hoster {
    const cur = this.getHoster(def.key);
    if (cur) {
      const missing = def.domains.filter((d) => !cur.domains.includes(d));
      if (missing.length === 0) return cur;
      return this.patchHoster(def.key, { domains: [...cur.domains, ...missing] }) ?? cur;
    }
    const ts = now();
    const next = (this.db.prepare('SELECT COALESCE(MAX(priority), -1) + 1 AS n FROM hosters').get() as { n: number }).n;
    this.db.prepare(`INSERT INTO hosters (key, label, domains, enabled, priority, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)`)
      .run(def.key, def.label, JSON.stringify(def.domains), Number(next), ts, ts);
    return this.getHoster(def.key)!;
  }

  patchHoster(key: string, patch: {
    label?: string; domains?: string[]; enabled?: boolean; priority?: number;
  }): Hoster | null {
    const cur = this.getHoster(key);
    if (!cur) return null;
    const next: Hoster = { ...cur, ...patch, updatedAt: now() };
    this.db.prepare('UPDATE hosters SET label=?, domains=?, enabled=?, priority=?, updated_at=? WHERE key=?')
      .run(next.label, JSON.stringify(next.domains), next.enabled ? 1 : 0, next.priority, next.updatedAt, key);
    return next;
  }

  /**
   * 実績を 1 つ足す。成功なら最終成功日時も進める。
   *
   * 台帳に無いキーは黙って無視する — 数え漏らしより、ジョブの進行を止めるほうが高くつく。
   */
  bumpHoster(key: string, kind: 'ok' | 'fail' | 'human'): void {
    const column = kind === 'ok' ? 'ok_count' : kind === 'fail' ? 'fail_count' : 'human_count';
    const ts = now();
    if (kind === 'ok') {
      this.db.prepare(`UPDATE hosters SET ${column} = ${column} + 1, last_ok_at = ?, updated_at = ? WHERE key = ?`)
        .run(ts, ts, key);
    } else {
      this.db.prepare(`UPDATE hosters SET ${column} = ${column} + 1, updated_at = ? WHERE key = ?`).run(ts, key);
    }
  }

  /**
   * 過去のジョブから数え直した実績をまとめて入れる (初回の取り込み用)。
   * bumpHoster と違って last_ok_at に当時の日時を入れられる。
   */
  seedHosterStats(key: string, s: { ok: number; fail: number; human: number; lastOkAt: string | null }): void {
    this.db.prepare(`UPDATE hosters
      SET ok_count = ok_count + ?, fail_count = fail_count + ?, human_count = human_count + ?,
          last_ok_at = CASE WHEN ? IS NULL THEN last_ok_at
                            WHEN last_ok_at IS NULL OR last_ok_at < ? THEN ? ELSE last_ok_at END,
          updated_at = ?
      WHERE key = ?`)
      .run(s.ok, s.fail, s.human, s.lastOkAt, s.lastOkAt, s.lastOkAt, now(), key);
  }

  /** 優先度を 0,1,2... に振り直す。並べ替えの後始末 */
  renumberHosters(keysInOrder: string[]): void {
    const stmt = this.db.prepare('UPDATE hosters SET priority = ?, updated_at = ? WHERE key = ?');
    const ts = now();
    keysInOrder.forEach((key, i) => stmt.run(i, ts, key));
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
