import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Queue } from './queue.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Route, Router } from './router.js';

/** 経路の判定を手で終わらせられるキュー。aria2 は渡された・取り消された GID を記録するだけ */
function makeQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-q-'));
  const cfg = { ...loadConfig(), dataDir: dir };
  const db = new Db(dir);
  let release: (r: Route) => void = () => {};
  const router = { resolve: () => new Promise<Route>((r) => { release = r; }) } as unknown as Router;
  const added: string[] = [];
  const canceled: string[] = [];
  const hooks: { onAdd?: () => Promise<void> } = {};
  const aria2 = {
    ready: async () => true,
    add: async () => { added.push('gid1'); await hooks.onAdd?.(); return 'gid1'; },
    cancel: async (j: { externalId: string | null }) => { if (j.externalId) canceled.push(j.externalId); },
  } as unknown as Aria2Engine;
  const stub = {} as unknown as Jd2Engine & BrowserEngine;
  const queue = new Queue(cfg, db, aria2, stub, stub, router);
  const user = db.createUser('tester', path.join(dir, 'downloads'));
  const resolve = () => release({ engine: 'aria2', resolved: { url: 'https://example.com/a.zip' } });
  return { db, queue, user, added, canceled, resolve, hooks };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

test('ジョブが無ければユーザーを削除できる', () => {
  const { db, user } = makeQueue();
  assert.equal(db.deleteUser(user.id), true);
});

test('解析中に中止したジョブは、解析が終わっても落とし始めない', async () => {
  const { db, queue, user, added, resolve } = makeQueue();
  const [job] = queue.add({ userId: user.id, urls: ['https://example.com/a.zip'] }).jobs;
  assert.equal(db.getJob(job.id)!.status, 'resolving');

  await queue.cancel(job.id);
  resolve();
  await tick();

  assert.equal(db.getJob(job.id)!.status, 'canceled');
  assert.deepEqual(added, []);
});

test('aria2 へ渡している間に削除されたら、aria2 側も取り消す', async () => {
  const { db, queue, user, canceled, resolve, hooks } = makeQueue();
  const [job] = queue.add({ userId: user.id, urls: ['https://example.com/a.zip'] }).jobs;
  // aria2.add が返る前に画面から消された状況
  hooks.onAdd = () => queue.remove(job.id);
  resolve();
  await tick();

  assert.equal(db.getJob(job.id), null);
  assert.deepEqual(canceled, ['gid1']);
});

test('順番待ちの間に中止した queued ジョブは起動しない', async () => {
  const { db, queue, user, resolve } = makeQueue();
  const { jobs } = queue.add({ userId: user.id, urls: ['https://example.com/a.zip', 'https://example.com/b.zip'] });
  // 1 本目が解析中、2 本目は pump の一覧に載ったまま順番待ち
  assert.equal(db.getJob(jobs[1].id)!.status, 'queued');
  await queue.cancel(jobs[1].id);
  resolve();
  await tick();
  assert.equal(db.getJob(jobs[1].id)!.status, 'canceled');
});
