import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db, now } from './db.js';
import { Queue } from './queue.js';
import { seriesKeyOf } from './volume.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';
import type { Job } from './types.js';

/**
 * 完了時の整理 (フォルダ分け + リネーム) を、実際に `Queue.onDone` を通して見る。
 * エンジンは呼ばない — ここで確かめたいのは「落ち終わった後に何をするか」だけ。
 */
async function harness(rename: { enabled?: boolean; folder?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-ren-'));
  const dest = path.join(dir, 'downloads');
  fs.mkdirSync(dest, { recursive: true });
  const base = loadConfig();
  const cfg = { ...base, dataDir: dir, rename: { enabled: true, folder: true, ...rename } };
  const db = new Db(dir);
  const stub = (name: string) => ({ status: () => ({ name, available: false, detail: 'test' }) });
  const queue = new Queue(
    cfg, db,
    stub('aria2') as unknown as Aria2Engine,
    stub('jd2') as unknown as Jd2Engine,
    stub('browser') as unknown as BrowserEngine,
    { resolve: () => new Promise(() => {}) } as unknown as Router,
  );
  const user = db.createUser('tester', dest);
  return { db, queue, user, dest };
}

/** 落とし終わった直後の状態を作る。ファイルの中身は HTML でなければ何でもよい */
function finished(db: Db, userId: number, opts: {
  id: string;
  filename: string;
  title?: string | null;
  author?: string | null;
  volumeFrom?: number | null;
  volumeTo?: number | null;
  dest: string;
  /** JD2 が掘るパッケージフォルダ。指定するとその下に置く */
  nested?: string;
}): Job {
  const ts = now();
  const job: Job = {
    id: opts.id,
    userId,
    url: 'https://dailyuploads.net/abcdef',
    destDir: opts.dest,
    engine: 'aria2',
    status: 'downloading',
    filename: opts.filename,
    bytesTotal: 8,
    bytesDone: 8,
    speed: 0,
    error: null,
    externalId: null,
    // 巻の解釈はジョブが持つ。台帳は無い (docs/ROADMAP.md 2.5)
    seriesKey: opts.title ? seriesKeyOf(opts.title) : null,
    volumeFrom: opts.volumeFrom ?? null,
    volumeTo: opts.volumeTo ?? null,
    meta: { item: { title: opts.title ?? null, author: opts.author ?? null } },
    createdAt: ts,
    updatedAt: ts,
  };
  db.insertJob(job);
  const dir = opts.nested ? path.join(opts.dest, opts.nested) : opts.dest;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, opts.filename), 'RAR!book');
  return job;
}

test('完了すると作品フォルダへ入れてリネームする', async () => {
  const { db, queue, user, dest } = await harness();
  finished(db, user.id, {
    id: 'j1', filename: 'dl_9f3a2b.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });

  queue.onDone('j1', 'dl_9f3a2b.rar');

  const moved = path.join(dest, '[著者] 作品名', '[著者] 作品名 第03巻.rar');
  assert.ok(fs.existsSync(moved), '作品フォルダに入っていない');
  assert.ok(!fs.existsSync(path.join(dest, 'dl_9f3a2b.rar')), '元の場所に残っている');
  // 画面に出る名前も新しいほうに揃える
  assert.equal(db.getJob('j1')?.filename, '[著者] 作品名 第03巻.rar');
  assert.equal(db.getJob('j1')?.status, 'done');
});

test('範囲ものは 第01-06巻 になる', async () => {
  const { db, queue, user, dest } = await harness();
  finished(db, user.id, {
    id: 'j2', filename: 'dl.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 1, volumeTo: 6,
  });

  queue.onDone('j2', 'dl.rar');

  assert.ok(fs.existsSync(path.join(dest, '[著者] 作品名', '[著者] 作品名 第01-06巻.rar')));
});

test('JD2 が掘ったフォルダから引き上げ、空になったら片付ける', async () => {
  const { db, queue, user, dest } = await harness();
  finished(db, user.id, {
    id: 'j3', filename: 'dl.rar', dest, nested: 'JD2 のパッケージ名',
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });

  queue.onDone('j3', 'dl.rar');

  assert.ok(fs.existsSync(path.join(dest, '[著者] 作品名', '[著者] 作品名 第03巻.rar')));
  assert.ok(!fs.existsSync(path.join(dest, 'JD2 のパッケージ名')), '空のフォルダが残っている');
});

test('同じ巻をもう一度落としたら連番を付ける (上書きしない)', async () => {
  const { db, queue, user, dest } = await harness();
  const folder = path.join(dest, '[著者] 作品名');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '[著者] 作品名 第03巻.rar'), '先にあったもの');

  finished(db, user.id, {
    id: 'j4', filename: 'dl.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });
  queue.onDone('j4', 'dl.rar');

  assert.equal(fs.readFileSync(path.join(folder, '[著者] 作品名 第03巻.rar'), 'utf8'), '先にあったもの');
  assert.ok(fs.existsSync(path.join(folder, '[著者] 作品名 第03巻 (2).rar')));
});

test('分割書庫は連番を保ったまま同じフォルダへ揃う', async () => {
  const { db, queue, user, dest } = await harness();
  for (const [id, file] of [['j5', 'dl.part1.rar'], ['j6', 'dl.part2.rar']] as const) {
    finished(db, user.id, {
      id, filename: file, dest,
      title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
    });
    queue.onDone(id, file);
  }

  const folder = path.join(dest, '[著者] 作品名');
  assert.ok(fs.existsSync(path.join(folder, '[著者] 作品名 第03巻.part1.rar')));
  assert.ok(fs.existsSync(path.join(folder, '[著者] 作品名 第03巻.part2.rar')));
});

test('巻数を読めなかったジョブは名前を変えない', async () => {
  const { db, queue, user, dest } = await harness();
  finished(db, user.id, { id: 'j7', filename: 'dl_9f3a2b.rar', dest, title: '作品名', author: '著者' });

  queue.onDone('j7', 'dl_9f3a2b.rar');

  assert.ok(fs.existsSync(path.join(dest, '[著者] 作品名', 'dl_9f3a2b.rar')));
  assert.equal(db.getJob('j7')?.filename, 'dl_9f3a2b.rar');
});

test('作品名も巻数も無いものは触らない', async () => {
  const { db, queue, user, dest } = await harness();
  finished(db, user.id, { id: 'j8', filename: 'rsdjf1me5yac.rar', dest });

  queue.onDone('j8', 'rsdjf1me5yac.rar');

  assert.ok(fs.existsSync(path.join(dest, 'rsdjf1me5yac.rar')));
});

test('rename.enabled が false なら落ちた名前のまま置く', async () => {
  const { db, queue, user, dest } = await harness({ enabled: false });
  finished(db, user.id, {
    id: 'j9', filename: 'dl.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });

  queue.onDone('j9', 'dl.rar');

  assert.ok(fs.existsSync(path.join(dest, 'dl.rar')));
});

test('rename.folder が false ならフォルダを掘らずリネームだけする', async () => {
  const { db, queue, user, dest } = await harness({ folder: false });
  finished(db, user.id, {
    id: 'j10', filename: 'dl.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });

  queue.onDone('j10', 'dl.rar');

  assert.ok(fs.existsSync(path.join(dest, '[著者] 作品名 第03巻.rar')));
});

test('落としている最中は、完了後に付く予定の名前を画面へ添える', async () => {
  const { db, queue, user, dest } = await harness();
  const job = finished(db, user.id, {
    id: 'j11', filename: 'RTAè£ç v07.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 7, volumeTo: 7,
  });

  assert.equal(queue.present(job).plannedName, '[著者] 作品名 第07巻.rar');

  // 完了後は台帳のファイル名そのものが正しい名前なので、予定名は出さない
  queue.onDone('j11', job.filename);
  assert.equal(queue.present(db.getJob('j11')!).plannedName, null);
});

test('リネームしない設定なら予定名は出さない', async () => {
  const { db, queue, user, dest } = await harness({ enabled: false });
  const job = finished(db, user.id, {
    id: 'j12', filename: 'dl.rar', dest,
    title: '作品名', author: '著者', volumeFrom: 3, volumeTo: 3,
  });

  assert.equal(queue.present(job).plannedName, null);
});
