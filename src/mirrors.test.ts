import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Queue } from './queue.js';
import { pickFreeHostMirror, sortByPriority } from './mirrors.js';
import { bootstrapHosters } from './hosters.js';
import { HOST_LIMIT } from './engines/jd2.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';

/** エンジンには触れず、router も解決しないので外へは 1 本も通信が出ない */
function makeQueue(priority: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-mir-'));
  const cfg = { ...loadConfig(), dataDir: dir, mirrors: { priority, hostLimitWaitSec: 0 } };
  const db = new Db(dir);
  // 優先度の正は台帳 (hosters テーブル)。config の並びはそこへ流し込んでから使う
  bootstrapHosters(db, priority);
  const stub = {} as unknown as Aria2Engine & Jd2Engine & BrowserEngine;
  const queue = new Queue(cfg, db, stub, stub, stub,
    { resolve: () => new Promise(() => {}) } as unknown as Router);
  const user = db.createUser('tester', path.join(dir, 'downloads'));
  return { db, queue, user };
}

const PRIORITY = ['dailyuploads.net', 'uploady.io', 'katfile.com'];

test('優先度順に並べ替える', () => {
  assert.deepEqual(
    sortByPriority(
      ['https://katfile.com/c', 'https://uploady.io/b', 'https://dailyuploads.net/a'],
      PRIORITY
    ),
    ['https://dailyuploads.net/a', 'https://uploady.io/b', 'https://katfile.com/c']
  );
});

test('優先度表に無いホストは末尾に回る', () => {
  assert.deepEqual(
    sortByPriority(['https://unknown.example/x', 'https://uploady.io/y'], PRIORITY),
    ['https://uploady.io/y', 'https://unknown.example/x']
  );
});

test('同順位は元の並びを保つ', () => {
  const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'];
  assert.deepEqual(sortByPriority(urls, PRIORITY), urls);
});

test('www とサブドメインも同じホストとして扱う', () => {
  assert.deepEqual(
    sortByPriority(['https://unknown.example/x', 'https://www.dailyuploads.net/a', 'https://cdn.uploady.io/b'], PRIORITY),
    ['https://www.dailyuploads.net/a', 'https://cdn.uploady.io/b', 'https://unknown.example/x']
  );
});

test('URL として読めないものは末尾に回る (落ちない)', () => {
  assert.deepEqual(
    sortByPriority(['not a url', 'https://uploady.io/y'], PRIORITY),
    ['https://uploady.io/y', 'not a url']
  );
});

test('投入時に候補が優先度順に並ぶ', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{
      urls: ['https://katfile.com/x', 'https://dailyuploads.net/x', 'https://uploady.io/x'],
      meta: { title: '作品名 第1巻' },
    }],
  });
  const job = db.getJob(r.created[0].id)!;
  assert.equal(job.url, 'https://dailyuploads.net/x');
  assert.deepEqual(job.meta.mirrors, ['https://uploady.io/x', 'https://katfile.com/x']);
});

test('失敗しても候補が残っていれば確定させず次のミラーへ移る', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://uploady.io/x', 'https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  assert.equal(db.getJob(id)!.url, 'https://dailyuploads.net/x');

  queue.onFailed(id, 'サイトが 522 を返しました');
  const job = db.getJob(id)!;
  assert.equal(job.url, 'https://uploady.io/x');
  assert.notEqual(job.status, 'failed');
  assert.equal(job.error, null);
  assert.deepEqual(job.meta.mirrors, []);
  const tried = job.meta.tried as { url: string; error: string }[];
  assert.equal(tried.length, 1);
  assert.equal(tried[0].url, 'https://dailyuploads.net/x');
  assert.match(tried[0].error, /522/);
});

test('候補を使い切ったら失敗を確定させる', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://uploady.io/x', 'https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  queue.onFailed(id, '1 回目');
  queue.onFailed(id, '2 回目');
  const job = db.getJob(id)!;
  assert.equal(job.status, 'failed');
  assert.equal(job.error, '2 回目');
  assert.equal((job.meta.tried as unknown[]).length, 2);
});

test('ミラーへ移る時は経路の記憶と進捗を落とす', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://uploady.io/x', 'https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  db.patchJob(id, { engine: 'browser', filename: 'old.rar', bytesDone: 999, meta: { route: 'browser' } });

  queue.onFailed(id, 'ブラウザ操作が完了しませんでした');
  const job = db.getJob(id)!;
  assert.equal(job.meta.route, '');
  assert.equal(job.engine, null);
  assert.equal(job.filename, null);
  assert.equal(job.bytesDone, 0);
});

test('ブラウザ引き継ぎの再試行余地があるうちはミラーへ移らない', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://uploady.io/x', 'https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  db.patchJob(id, { engine: 'aria2', meta: { via: 'browser' } });

  queue.onFailed(id, '403 Forbidden');
  const job = db.getJob(id)!;
  assert.equal(job.status, 'failed');
  assert.equal(job.meta.browserDirect, true);
  // 同じ URL で試す余地を使い切る前にミラーへ移らない
  assert.equal(job.url, 'https://dailyuploads.net/x');
  assert.deepEqual(job.meta.mirrors, ['https://uploady.io/x']);
});

test('合流で増えた候補も優先度順に並び直す', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const first = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://katfile.com/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = first.created[0].id;

  await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://unknown.example/x', 'https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' }, source: 'dryeyes:w2' }],
  });
  const job = db.getJob(id)!;
  // 今試している url は乗り換えない。増えた候補だけが優先度順に並ぶ
  assert.equal(job.url, 'https://katfile.com/x');
  assert.deepEqual(job.meta.mirrors, ['https://dailyuploads.net/x', 'https://unknown.example/x']);
});

// ---- ホストの同時ダウンロード上限で別のアップローダへ移る ----------------

const settle = () => new Promise((r) => setImmediate(r));

test('ふさがっているホストを飛ばして、空いている候補を選ぶ', () => {
  const mirrors = ['https://uploady.io/x', 'https://katfile.com/x'];
  assert.equal(
    pickFreeHostMirror(mirrors, ['uploady.io'], PRIORITY),
    'https://katfile.com/x'
  );
});

test('空いている中では優先度の高いものを選ぶ', () => {
  const mirrors = ['https://katfile.com/x', 'https://uploady.io/x'];
  assert.equal(pickFreeHostMirror(mirrors, [], PRIORITY), 'https://uploady.io/x');
});

test('全部ふさがっていれば選ばない (移し替えても同じ上限に当たる)', () => {
  const mirrors = ['https://uploady.io/x', 'https://katfile.com/x'];
  assert.equal(pickFreeHostMirror(mirrors, ['uploady.io', 'katfile.com'], PRIORITY), null);
});

test('上限で待たされたら、空いている別のアップローダへ移る', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [
      {
        urls: ['https://dailyuploads.net/x', 'https://uploady.io/x', 'https://katfile.com/x'],
        meta: { title: '作品名 第1巻' },
      },
      // uploady は別のジョブが使っている。移し替えても仕方がないので飛ばされるはず
      { urls: ['https://uploady.io/y'], meta: { title: '作品名 第2巻' } },
    ],
  });
  const [first, second] = r.created;
  db.patchJob(first.id, { status: 'downloading', engine: 'jd2' });
  db.patchJob(second.id, { status: 'downloading', engine: 'jd2' });

  queue.onHostLimited(first.id, 'Download limit reached');
  await settle();

  const job = db.getJob(first.id)!;
  assert.equal(job.url, 'https://katfile.com/x');
  // 今の URL は失敗として捨てず、末尾へ回す。上限は時間で空くため
  assert.deepEqual(job.meta.mirrors, ['https://uploady.io/x', 'https://dailyuploads.net/x']);
  assert.deepEqual(job.meta.tried ?? [], []);
});

test('移せる先が無ければ、失敗にせず待たせたままにする', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [
      { urls: ['https://dailyuploads.net/x', 'https://uploady.io/x'], meta: { title: '作品名 第1巻' } },
      { urls: ['https://uploady.io/y'], meta: { title: '作品名 第2巻' } },
    ],
  });
  const [first, second] = r.created;
  db.patchJob(first.id, { status: 'downloading', engine: 'jd2' });
  db.patchJob(second.id, { status: 'downloading', engine: 'jd2' });

  queue.onHostLimited(first.id, 'Download limit reached');
  await settle();

  const job = db.getJob(first.id)!;
  assert.equal(job.url, 'https://dailyuploads.net/x');
  assert.equal(job.status, 'downloading');
  assert.match(String(job.meta.detail), /待機/);
});

// ---- 「待て」と言われている状態の見分け ----------------------------------

test('JD2 の上限メッセージを拾う (英語・日本語とも実機の文言)', () => {
  assert.ok(HOST_LIMIT.test('Download limit reached or wait until next download can be started'));
  assert.ok(HOST_LIMIT.test('Too many simultaneous downloads'));
  // 日本語の JD2 は残り時間で出す
  assert.ok(HOST_LIMIT.test('34s 待機'));
  assert.ok(HOST_LIMIT.test('1m:32s 待機'));
  assert.ok(HOST_LIMIT.test('ダウンロード制限に達しました'));
});

test('進行中・別種の停止は上限と見なさない', async () => {
  // ここを広く取りすぎると、落ちているのに別ホストへ移してしまう
  assert.ok(!HOST_LIMIT.test('Downloading'));
  assert.ok(!HOST_LIMIT.test('Connecting...'));
  assert.ok(!HOST_LIMIT.test('開始中...'));
  // CAPTCHA まわりは別の経路 (ブラウザ引き継ぎ) が持つ
  assert.ok(!HOST_LIMIT.test('スキップ - キャプチャ無視'));
  assert.ok(!HOST_LIMIT.test('Blocked by Cloudflare Site Offline'));
  assert.ok(!HOST_LIMIT.test(''));
});

// ---- 落ちてこなかったものを完了にしない ----------------------------------

/** 完了を受け取れる状態のジョブを 1 件用意する */
async function downloadedJob(priority = PRIORITY) {
  const h = makeQueue(priority);
  const r = await h.queue.addItems({
    userId: h.user.id,
    items: [{ urls: ['https://dailyuploads.net/x', 'https://uploady.io/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  const dest = h.db.getJob(id)!.destDir;
  fs.mkdirSync(dest, { recursive: true });
  return { ...h, id, dest };
}

test('0 バイトは完了にせず、次のミラーへ回す', async () => {
  const { db, queue, id, dest } = await downloadedJob();
  fs.writeFileSync(path.join(dest, 'x.rar'), '');

  queue.onDone(id, 'x.rar');

  const job = db.getJob(id)!;
  assert.notEqual(job.status, 'done');
  // 候補が残っているので失敗を確定させず次へ移る
  assert.equal(job.url, 'https://uploady.io/x');
  // done になっていないので「取得済み」の判定にも参加しない。
  // ここが done に化けると、その巻は二度と落ちてこない (src/library.ts)
});

test('HTML のエラーページを掴まされても完了にしない', async () => {
  const { db, queue, id, dest } = await downloadedJob();
  // ホスターは拡張子をそのままにエラーページを返してくる
  fs.writeFileSync(path.join(dest, 'x.rar'), '<!DOCTYPE html>\n<html><body>Link expired</body></html>');

  queue.onDone(id, 'x.rar');

  const job = db.getJob(id)!;
  assert.notEqual(job.status, 'done');
  assert.equal(job.url, 'https://uploady.io/x');
});

test('中身があれば完了。実ファイルの大きさを正とする', async () => {
  const { db, queue, id, dest } = await downloadedJob();
  const body = Buffer.alloc(4096, 7);
  fs.writeFileSync(path.join(dest, 'x.rar'), body);

  queue.onDone(id, 'x.rar');

  const job = db.getJob(id)!;
  assert.equal(job.status, 'done');
  // 進捗を 1 度も報告しないエンジンでも 0 B のままにならない
  assert.equal(job.bytesTotal, 4096);
  assert.equal(job.bytesDone, 4096);
  // done になったジョブは、棚に載るまでの間「取得済み」として次の投入を弾く
});

test('ファイルが見つからなくても、受け取った実績があれば完了にする', async () => {
  // JD2 はパッケージ名のフォルダへ別名で置くことがある。
  // 見つけられないだけの完走を失敗にするほうが害が大きい
  const { db, queue, id } = await downloadedJob();
  db.patchJob(id, { bytesDone: 12345, bytesTotal: 12345 });

  queue.onDone(id, '見つからない名前.rar');
  assert.equal(db.getJob(id)!.status, 'done');
});

test('ファイルも無く 1 バイトも受け取っていなければ完了にしない', async () => {
  const { db, queue, id } = await downloadedJob();
  queue.onDone(id, '見つからない名前.rar');
  assert.notEqual(db.getJob(id)!.status, 'done');
});

test('再試行は候補を全部やり直す (見限った分も戻して優先度順に並べ直す)', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{
      urls: ['https://dailyuploads.net/x', 'https://uploady.io/x', 'https://katfile.com/x'],
      meta: { title: '作品名 第1巻' },
    }],
  });
  const id = r.created[0].id;
  queue.onFailed(id, '1 回目');
  queue.onFailed(id, '2 回目');
  queue.onFailed(id, '3 回目');
  assert.equal(db.getJob(id)!.status, 'failed');

  db.patchJob(id, { filename: 'old.rar', bytesDone: 999, meta: { route: 'browser' } });
  const job = queue.retry(id);

  assert.equal(job.status, 'queued');
  assert.equal(job.error, null);
  // 1 件目 (優先度が一番高いところ) からやり直す
  assert.equal(job.url, 'https://dailyuploads.net/x');
  assert.deepEqual(job.meta.mirrors, ['https://uploady.io/x', 'https://katfile.com/x']);
  assert.deepEqual(job.meta.tried, []);
  // 前回の進捗と経路は引き継がない
  assert.equal(job.filename, null);
  assert.equal(job.bytesDone, 0);
  assert.equal(job.meta.route, '');
});

test('再試行は候補が 1 件でも動く', async () => {
  const { db, queue, user } = makeQueue(PRIORITY);
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://uploady.io/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  queue.onFailed(id, '駄目でした');

  const job = queue.retry(id);
  assert.equal(job.url, 'https://uploady.io/x');
  assert.deepEqual(job.meta.mirrors, []);
  assert.deepEqual(job.meta.tried, []);
  assert.equal(db.getJob(id)!.status, 'queued');
});
