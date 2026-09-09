import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Queue } from './queue.js';
import { buildServer } from './server.js';
import { candidateFromFilename, scanFilenames, stripExtension } from './inventory.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';

const USER = 1;

async function harness(scanDirs: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-inv-'));
  const cfg = { ...loadConfig(), dataDir: dir, library: { scanDirs, scanRecursive: false } };
  const db = new Db(dir);
  // 台帳はユーザー単位なので、持ち主がいないと 1 件も入らない
  db.createUser('seamo', path.join(dir, 'downloads'));
  const stub = (name: string) => ({ status: () => ({ name, available: false, detail: 'test' }) });
  const engine = stub('x') as unknown as Aria2Engine & Jd2Engine & BrowserEngine;
  const queue = new Queue(cfg, db, engine, engine, engine,
    { resolve: () => new Promise(() => {}) } as unknown as Router);
  const app = await buildServer({ cfg, db, queue, aria2: engine, jd2: engine, browser: engine });
  return { app, db, dir };
}

test('拡張子と分割書庫の連番を落とす', () => {
  assert.equal(stripExtension('作品名 第03巻.rar'), '作品名 第03巻');
  assert.equal(stripExtension('作品名 第03巻.part1.rar'), '作品名 第03巻');
  assert.equal(stripExtension('作品名 第03巻.r00'), '作品名 第03巻');
  assert.equal(stripExtension('作品名 第03巻.zip'), '作品名 第03巻');
  assert.equal(stripExtension('作品名 第03巻.cbz'), '作品名 第03巻');
});

test('ファイル名から巻数を読む', () => {
  const c = candidateFromFilename('[著者] 作品名 第03巻.rar');
  assert.deepEqual([c.volumeFrom, c.volumeTo], [3, 3]);
  const r = candidateFromFilename('[著者] 作品名 第01-06巻.rar');
  assert.deepEqual([r.volumeFrom, r.volumeTo], [1, 6]);
});

test('分割書庫は 1 件にまとめる', () => {
  const got = scanFilenames([
    '作品名 第03巻.part1.rar',
    '作品名 第03巻.part2.rar',
    '作品名 第03巻.part3.rar',
  ]);
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].volumeFrom, got[0].volumeTo], [3, 3]);
});

test('巻数を読めなかったファイルも候補には残す (台帳には入らない)', () => {
  const got = scanFilenames(['作品名 第01巻.rar', 'よくわからない名前.rar']);
  assert.equal(got.length, 2);
  const unusable = got.find((c) => c.file === 'よくわからない名前.rar')!;
  assert.equal(unusable.volumeFrom, null);
});

test('手動登録は範囲を 1 巻ずつに展開する', async () => {
  const { app, db } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/items',
    payload: { userId: USER, title: '作品名', author: '著者', volumes: '1-7' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().created.length, 7);
  assert.equal(db.listItems().length, 7);
  // 歯抜けを 1 件だけ消せる
  const seventh = db.listItems().find((i) => i.volumeFrom === 7)!;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/items/${seventh.id}` })).statusCode, 200);
  assert.equal(db.listItems().length, 6);
  await app.close();
});

test('登録済みの巻は重複して積まない', async () => {
  const { app, db } = await harness();
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '1-3' } });
  const again = await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '2-5' } });
  const body = again.json();
  assert.equal(body.created.length, 2); // 4, 5 だけ
  assert.equal(body.skipped, 2);
  assert.equal(db.listItems().length, 5);
  await app.close();
});

test('巻数として読めない入力は 400', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: 'あ' } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('手動で登録した所持は、DryEyes からの投入を止める', async () => {
  const { app } = await harness();
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '1-7' } });

  // 登録した本人が投入したときに止まる。別のユーザーなら止まらない
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: 'Bearer ' + loadConfig().apiToken },
    payload: { userId: USER, items: [{ urls: ['https://a.example/3'], meta: { title: '作品名 第3巻' } }] },
  });
  const body = res.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /所持済み/);
  await app.close();
});

test('scanDirs が空ならスキャンは拒否する', async () => {
  const { app } = await harness();
  const res = await app.inject({ method: 'POST', url: '/api/items/scan', payload: {} });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /scanDirs/);
  await app.close();
});

test('scanDirs に無いフォルダは読ませない', async () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-scan-'));
  const { app } = await harness([allowed]);
  const res = await app.inject({ method: 'POST', url: '/api/items/scan', payload: { dir: os.tmpdir() } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('スキャンは既定では候補を返すだけで、commit で台帳に入る', async () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-scan-'));
  fs.writeFileSync(path.join(allowed, '[著者] 作品名 第01巻.rar'), 'x');
  fs.writeFileSync(path.join(allowed, '[著者] 作品名 第02巻.rar'), 'x');
  fs.writeFileSync(path.join(allowed, 'メモ.txt'), 'x');
  const { app, db } = await harness([allowed]);

  const dry = await app.inject({ method: 'POST', url: '/api/items/scan', payload: { dir: allowed } });
  assert.equal(dry.json().candidates.length, 2); // .txt は対象外
  assert.equal(dry.json().committed, false);
  assert.equal(db.listItems().length, 0);

  const commit = await app.inject({
    method: 'POST', url: '/api/items/scan', payload: { userId: USER, dir: allowed, commit: true },
  });
  assert.equal(commit.json().created.length, 2);
  assert.equal(db.listItems().length, 2);
  await app.close();
});

const AUTH = { authorization: 'Bearer ' + loadConfig().apiToken };

test('所持の判定は投入せずに行える', async () => {
  const { app, db } = await harness();
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '1-6' } });

  const res = await app.inject({
    method: 'POST', url: '/api/items/check', headers: AUTH,
    payload: {
      userId: USER,
      items: [
        { sourceKey: 'k1', urls: ['https://a/3'], meta: { title: '作品名 第3巻' } },
        { sourceKey: 'k2', urls: ['https://a/9'], meta: { title: '作品名 第9巻' } },
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const [held, missing] = res.json().results;

  assert.equal(held.sourceKey, 'k1');
  assert.equal(held.state, 'skip');
  assert.match(held.reason, /所持済み/);
  assert.deepEqual([held.volumeFrom, held.volumeTo], [3, 3]);

  assert.equal(missing.state, 'new');
  assert.equal(missing.reason, null);

  // 調べただけで台帳は増えない
  assert.equal(db.listItems().length, 6);
  await app.close();
});

test('ダウンロード中のものは merge として返る', async () => {
  const { app, db, dir } = await harness();
  const other = db.createUser('u', path.join(dir, 'downloads2'));
  await app.inject({
    method: 'POST', url: '/api/jobs', headers: AUTH,
    payload: { userId: USER, items: [{ urls: ['https://a/3'], meta: { title: '作品名 第3巻' } }] },
  });

  const check = (userId: number) => app.inject({
    method: 'POST', url: '/api/items/check', headers: AUTH,
    payload: { userId, items: [{ sourceKey: 'k', urls: ['https://b/3'], meta: { title: '作品名 第3巻' } }] },
  });

  assert.equal((await check(USER)).json().results[0].state, 'merge');
  // 落としているのは別の人。保存先が違うので相乗りさせない
  assert.equal((await check(other.id)).json().results[0].state, 'new');
  await app.close();
});

test('判定にもトークンが要る (台帳の中身が分かるため)', async () => {
  const { app } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/items/check',
    payload: { userId: USER, items: [{ urls: ['https://a/3'], meta: { title: '作品名 第3巻' } }] },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('items 形式でまとめて所持登録できる', async () => {
  const { app, db } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/items', headers: AUTH,
    payload: {
      userId: USER,
      items: [
        { title: '作品名', author: '著者', volumes: '1' },
        { title: '作品名', author: '著者', volumes: '2' },
        { title: '作品名', author: '著者', volumes: 'よく分からない' }, // 巻数が読めない
      ],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.created.length, 2);
  assert.equal(body.skipped, 1);
  assert.equal(db.listItems().length, 2);
  await app.close();
});

test('まとめて登録しても、既にあるものは重複させない', async () => {
  const { app, db } = await harness();
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '1-3' } });
  const res = await app.inject({
    method: 'POST', url: '/api/items', headers: AUTH,
    payload: { userId: USER, items: [{ title: '作品名', volumes: '2' }, { title: '作品名', volumes: '5' }] },
  });
  assert.equal(res.json().created.length, 1);
  assert.equal(res.json().skipped, 1);
  assert.equal(db.listItems().length, 4);
  await app.close();
});

test('台帳を触る口はユーザーを要求する', async () => {
  const { app } = await harness();
  // ユーザーを言わずに登録しようとしても通らない (誰の所持か決まらない)
  const noUser = await app.inject({
    method: 'POST', url: '/api/items', payload: { title: '作品名', volumes: '1' },
  });
  assert.equal(noUser.statusCode, 400);

  // いないユーザーも引き取らない
  const ghost = await app.inject({
    method: 'POST', url: '/api/items', payload: { userId: 999, title: '作品名', volumes: '1' },
  });
  assert.equal(ghost.statusCode, 400);
  assert.match(ghost.json().error, /ユーザー/);
  await app.close();
});

test('台帳の一覧はユーザーで絞れる', async () => {
  const { app, db, dir } = await harness();
  const other = db.createUser('u2', path.join(dir, 'downloads2'));
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: USER, title: '作品名', volumes: '1-2' } });
  await app.inject({ method: 'POST', url: '/api/items', payload: { userId: other.id, title: '作品名', volumes: '1' } });

  assert.equal(db.listItems().length, 3);
  assert.equal(db.listItems({ userId: USER }).length, 2);
  assert.equal(db.listItems({ userId: other.id }).length, 1);

  const res = await app.inject({ method: 'GET', url: `/api/items?userId=${other.id}` });
  assert.equal(res.json().items.length, 1);
  await app.close();
});
