import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Queue } from './queue.js';
import { buildServer } from './server.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';

const TOKEN = 'test-token';

/**
 * エンジンには触らずに HTTP の配線だけを見る。
 * router.resolve を解決しない Promise にしてあるので、投入されたジョブは resolving で止まり、
 * 外へは 1 本も通信が出ない (合流の検証もこの状態で安定する)。
 */
async function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-srv-'));
  const dest = path.join(dir, 'downloads');
  const cfg = { ...loadConfig(), dataDir: dir, apiToken: TOKEN };
  const db = new Db(dir);
  const stub = (name: string) => ({ status: () => ({ name, available: false, detail: 'test' }) });
  const queue = new Queue(
    cfg, db,
    stub('aria2') as unknown as Aria2Engine,
    stub('jd2') as unknown as Jd2Engine,
    stub('browser') as unknown as BrowserEngine,
    { resolve: () => new Promise(() => {}) } as unknown as Router,
  );
  const app = await buildServer({
    cfg, db, queue,
    aria2: stub('aria2') as unknown as Aria2Engine,
    jd2: stub('jd2') as unknown as Jd2Engine,
    browser: stub('browser') as unknown as BrowserEngine,
  });
  const user = db.createUser('tester', dest);
  return { app, db, queue, user, dest };
}

const item = (title: string, urls: string[], extra: Record<string, unknown> = {}) => ({
  urls,
  source: 'dryeyes:watch-1',
  sourceKey: 'watch-1:abc',
  meta: { title, author: '著者', ...extra },
});

test('items 投入はトークンが無いと 401', async () => {
  const { app, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://a.example/3'])] },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('正しいトークンなら投入され、台帳に pending が積まれる', async () => {
  const { app, db, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://a.example/3', 'https://b.example/3'])] },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.created.length, 1);
  // 先頭が本命、残りはミラー候補
  assert.equal(body.created[0].url, 'https://a.example/3');
  assert.deepEqual(body.created[0].meta.mirrors, ['https://b.example/3']);
  assert.equal(body.created[0].meta.source, 'dryeyes:watch-1');
  assert.equal(body.created[0].meta.sourceKey, 'watch-1:abc');

  const entry = db.findItemByJob(body.created[0].id);
  assert.equal(entry?.status, 'pending');
  assert.deepEqual([entry?.volumeFrom, entry?.volumeTo], [3, 3]);
  await app.close();
});

test('別サイトから同じ巻が来たら合流し、ジョブは増えない', async () => {
  const { app, db, user } = await harness();
  const auth = { authorization: `Bearer ${TOKEN}` };

  const first = await app.inject({
    method: 'POST', url: '/api/jobs', headers: auth,
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://a.example/3'])] },
  });
  const jobId = first.json().created[0].id;

  const second = await app.inject({
    method: 'POST', url: '/api/jobs', headers: auth,
    payload: { userId: user.id, items: [{ ...item('作品名 第3巻', ['https://c.example/3']), source: 'dryeyes:watch-2' }] },
  });
  const body = second.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.merged.length, 1);
  assert.equal(body.merged[0].jobId, jobId);
  // 投入元が結果を突き合わせられるよう sourceKey を返す (title は重複しうる)
  assert.equal(body.merged[0].sourceKey, 'watch-1:abc');

  // 候補が増えている
  assert.deepEqual(db.getJob(jobId)?.meta.mirrors, ['https://c.example/3']);
  // どこから合流したかが残る
  const entry = db.findItemByJob(jobId);
  assert.equal(entry?.mergedFrom.length, 1);
  assert.equal(entry?.mergedFrom[0].source, 'dryeyes:watch-2');
  assert.equal(db.listJobs().length, 1);
  await app.close();
});

test('取得済みの巻は投入されない', async () => {
  const { app, db, user, queue, dest } = await harness();
  const auth = { authorization: `Bearer ${TOKEN}` };

  const first = await app.inject({
    method: 'POST', url: '/api/jobs', headers: auth,
    payload: { userId: user.id, items: [item('作品名 1-6巻', ['https://a.example/1-6'])] },
  });
  // 完了は実ファイルを見て判断されるので、本物を置いてから呼ぶ
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'x.rar'), 'RAR content');
  queue.onDone(first.json().created[0].id, 'x.rar');

  const second = await app.inject({
    method: 'POST', url: '/api/jobs', headers: auth,
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://c.example/3'])] },
  });
  const body = second.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /取得済み/);
  assert.equal(body.skipped[0].sourceKey, 'watch-1:abc');

  // 未所持が残る範囲は落とす
  const third = await app.inject({
    method: 'POST', url: '/api/jobs', headers: auth,
    payload: { userId: user.id, items: [item('作品名 4-8巻', ['https://c.example/4-8'])] },
  });
  assert.equal(third.json().created.length, 1);
  await app.close();
});

test('上限を超えた投入は切り捨てて件数を返す', async () => {
  const { app, user } = await harness();
  const items = Array.from({ length: 25 }, (_, i) => item(`作品名 第${i + 1}巻`, [`https://a.example/${i + 1}`]));
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { userId: user.id, items },
  });
  const body = res.json();
  assert.equal(body.created.length, 20);
  assert.equal(body.truncated, 5);
  await app.close();
});

test('UI からの urls 形式はトークン不要のまま通る', async () => {
  const { app, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { userId: user.id, urls: ['https://a.example/x'] },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().jobs.length, 1);
  await app.close();
});
