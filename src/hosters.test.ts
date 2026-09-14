import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Queue } from './queue.js';
import {
  bootstrapDefs, bootstrapHosters, countFromJobs, hosterKeyOf,
  newHosterFor, priorityDomains, registrableLabel, splitByEnabled,
} from './hosters.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import type { Router } from './router.js';
import type { Job } from './types.js';

const PRIORITY = ['dailyuploads.net', 'uploady.io', 'katfile.com'];

/** エンジンにも router にも触れないキュー。外へは 1 本も通信が出ない */
function makeQueue(priority = PRIORITY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-host-'));
  const cfg = { ...loadConfig(), dataDir: dir, mirrors: { priority, hostLimitWaitSec: 0 } };
  const db = new Db(dir);
  bootstrapHosters(db, priority);
  const stub = {} as unknown as Aria2Engine & Jd2Engine & BrowserEngine;
  const queue = new Queue(cfg, db, stub, stub, stub,
    { resolve: () => new Promise(() => {}) } as unknown as Router);
  const user = db.createUser('tester', path.join(dir, 'downloads'));
  return { db, queue, user };
}

// ---- 業者の同定 ----------------------------------------------------------

test('別名ドメインは同じ業者キーになる', () => {
  assert.equal(registrableLabel('frdl.io'), 'frdl');
  assert.equal(registrableLabel('frdl.hk'), 'frdl');
  assert.equal(registrableLabel('www.frdl.by'), 'frdl');
});

test('サブドメインは業者名まで削る', () => {
  assert.equal(registrableLabel('e21.urleecher.com'), 'urleecher');
  assert.equal(registrableLabel('cdn.freedl.ink'), 'freedl');
});

test('2 つで 1 つの TLD を業者名と間違えない', () => {
  assert.equal(registrableLabel('example.co.uk'), 'example');
  assert.equal(registrableLabel('files.com.br'), 'files');
});

test('台帳のドメイン一覧から業者を引ける', () => {
  const hosters = [
    { key: 'frdl', domains: ['frdl.io', 'frdl.hk'] },
    { key: 'katfile', domains: ['katfile.biz'] },
  ];
  assert.equal(hosterKeyOf('https://frdl.hk/abc/x.rar', hosters), 'frdl');
  assert.equal(hosterKeyOf('https://www.katfile.biz/x', hosters), 'katfile');
  // 台帳に無いものは「知らない」であって「使えない」ではない
  assert.equal(hosterKeyOf('https://civitai.com/models/1', hosters), null);
  assert.equal(hosterKeyOf('not a url', hosters), null);
});

test('未知ドメインの行は既存の業者キーに吸収される形で作る', () => {
  // frdl が明日 frdl.xyz を使い始めても、同じ 'frdl' の行に足せる
  assert.deepEqual(newHosterFor('https://frdl.xyz/x'), {
    key: 'frdl', label: 'frdl.xyz', domains: ['frdl.xyz'],
  });
  assert.equal(newHosterFor('not a url'), null);
});

// ---- 台帳の用意 ----------------------------------------------------------

test('config の並びを業者単位に畳む', () => {
  const defs = bootstrapDefs(['katfile.biz', 'dailyuploads.net']);
  // 並びは config のまま。katfile.biz と katfile.com は 1 行にまとまる
  assert.equal(defs[0].key, 'katfile');
  assert.equal(defs[1].key, 'dailyuploads');
  assert.ok(defs[0].domains.includes('katfile.com'));
  // config に無い既定の業者も台帳には出す (使うかは人間が決める)
  assert.ok(defs.some((d) => d.key === 'rapidgator'));
});

test('起動のたびに行が増えたり優先度が戻ったりしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-boot-'));
  const db = new Db(dir);
  bootstrapHosters(db, PRIORITY);
  const first = db.listHosters();

  // 人間が並べ替えて、1 つ使用しないに倒した
  db.renumberHosters([...first.map((h) => h.key)].reverse());
  db.patchHoster('katfile', { enabled: false });

  bootstrapHosters(db, PRIORITY);
  const second = db.listHosters();

  assert.equal(second.length, first.length);
  assert.equal(second.find((h) => h.key === 'katfile')!.enabled, false);
  assert.equal(second[0].key, first[first.length - 1].key);
});

test('新しいドメインは既存の業者に足され、行は増えない', () => {
  const { db } = makeQueue();
  const before = db.listHosters().length;
  db.ensureHoster(newHosterFor('https://frdl.xyz/x')!);
  assert.equal(db.listHosters().length, before);
  assert.ok(db.getHoster('frdl')!.domains.includes('frdl.xyz'));
});

test('優先度順のドメイン列にすべての別名が展開される', () => {
  const domains = priorityDomains([
    { priority: 1, domains: ['b.net'] },
    { priority: 0, domains: ['a.io', 'a.hk'] },
  ]);
  assert.deepEqual(domains, ['a.io', 'a.hk', 'b.net']);
});

// ---- 使用しないアップローダを弾く ----------------------------------------

test('使用しない業者だけを落とし、知らない URL は残す', () => {
  const hosters = [
    { key: 'katfile', label: 'katfile', domains: ['katfile.biz'], enabled: false },
    { key: 'uploady', label: 'uploady', domains: ['uploady.io'], enabled: true },
  ];
  const r = splitByEnabled(
    ['https://katfile.biz/a', 'https://uploady.io/b', 'https://civitai.com/models/1'],
    hosters,
  );
  assert.deepEqual(r.usable, ['https://uploady.io/b', 'https://civitai.com/models/1']);
  assert.deepEqual(r.rejected, [{ url: 'https://katfile.biz/a', hoster: 'katfile' }]);
});

test('使用しないアップローダの URL はジョブにならない', () => {
  const { db, queue, user } = makeQueue();
  db.patchHoster('katfile', { enabled: false });

  const r = queue.add({ userId: user.id, urls: ['https://katfile.com/x/a.rar'] });

  assert.equal(r.jobs.length, 0);
  assert.deepEqual(r.rejected, [{ url: 'https://katfile.com/x/a.rar', hoster: 'katfile' }]);
  assert.equal(db.listJobs().length, 0);
});

test('ミラーの一部が使用しない設定でも、残りでジョブを作る', async () => {
  const { db, queue, user } = makeQueue();
  db.patchHoster('katfile', { enabled: false });

  const r = await queue.addItems({
    userId: user.id,
    items: [{
      urls: ['https://katfile.com/x', 'https://dailyuploads.net/x', 'https://uploady.io/x'],
      meta: { title: '作品名 第1巻' },
    }],
  });

  assert.equal(r.created.length, 1);
  assert.equal(r.rejected.length, 0);
  const job = db.getJob(r.created[0].id)!;
  assert.equal(job.url, 'https://dailyuploads.net/x');
  // 使用しない候補は控えにも残さない。残すと失敗のたびにそこへ移ってしまう
  assert.deepEqual(job.meta.mirrors, ['https://uploady.io/x']);
});

test('候補が全部使用しない設定なら、取得済みとは別枠で返す', async () => {
  const { db, queue, user } = makeQueue();
  db.patchHoster('katfile', { enabled: false });

  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://katfile.com/x', 'https://katfile.biz/y'], meta: { title: '作品名 第1巻' } }],
  });

  assert.equal(r.created.length, 0);
  assert.equal(r.skipped.length, 0, '「もう持っている」と混ぜない');
  assert.equal(r.rejected.length, 1);
  assert.deepEqual(r.rejected[0].hosters, ['katfile']);
  assert.equal(db.listJobs().length, 0);
});

// ---- 実績を数える --------------------------------------------------------

test('完走したら成功が増え、最終成功日時が入る', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  const dest = db.getJob(id)!.destDir;
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'x.rar'), 'PK dummy payload');

  queue.onDone(id, 'x.rar');

  const h = db.getHoster('dailyuploads')!;
  assert.equal(h.okCount, 1);
  assert.equal(h.failCount, 0);
  assert.ok(h.lastOkAt);
});

test('0 バイトを掴まされた時は成功に数えない', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  const dest = db.getJob(id)!.destDir;
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'x.rar'), '');

  queue.onDone(id, 'x.rar');

  const h = db.getHoster('dailyuploads')!;
  assert.equal(h.okCount, 0);
  assert.equal(h.failCount, 1, '落ちてこなかったのだから失敗');
});

test('ミラーへ移った時も、見限った側に失敗が付く', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://dailyuploads.net/x', 'https://uploady.io/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;

  queue.onFailed(id, 'CAPTCHA を解けません');   // dailyuploads を見限る
  queue.onFailed(id, 'ファイルが見つかりません'); // uploady も駄目で確定

  assert.equal(db.getHoster('dailyuploads')!.failCount, 1);
  assert.equal(db.getHoster('uploady')!.failCount, 1);
  assert.equal(db.getJob(id)!.status, 'failed');
});

test('人間待ちはジョブにつき 1 回だけ数える', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://dailyuploads.net/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  db.patchJob(id, { status: 'downloading', engine: 'browser' });

  // エンジンは 1 秒ごとに報告してくる。文言が変わっても件数は 1 のまま
  queue.onWaitingHuman(id, true, 'Turnstile のチェックを押してください');
  queue.onWaitingHuman(id, true, 'Turnstile のチェックを押してください');
  queue.onWaitingHuman(id, true, 'まだ押されていません');

  assert.equal(db.getHoster('dailyuploads')!.humanCount, 1);
  assert.equal(db.getJob(id)!.status, 'waiting_human');
});

test('別のアップローダへ移ったら人間待ちをもう一度数える', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://dailyuploads.net/x', 'https://uploady.io/x'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  db.patchJob(id, { status: 'downloading', engine: 'browser' });
  queue.onWaitingHuman(id, true, '押してください');

  queue.onFailed(id, '20 分待っても押されませんでした');
  db.patchJob(id, { status: 'downloading', engine: 'browser' });
  queue.onWaitingHuman(id, true, '押してください');

  assert.equal(db.getHoster('dailyuploads')!.humanCount, 1);
  assert.equal(db.getHoster('uploady')!.humanCount, 1);
});

test('直リンクに化けた後に完走しても、実績は元のアップローダに付く', async () => {
  const { db, queue, user } = makeQueue();
  const r = await queue.addItems({
    userId: user.id,
    items: [{ urls: ['https://frdl.io/x/a.rar'], meta: { title: '作品名 第1巻' } }],
  });
  const id = r.created[0].id;
  // ブラウザが直リンクを掴むと url は配信 CDN に差し替わる (実際に起きた形)
  db.patchJob(id, { url: 'https://e21.urleecher.com/d/abcdef/a.rar' });
  const dest = db.getJob(id)!.destDir;
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'a.rar'), 'PK dummy payload');

  queue.onDone(id, 'a.rar');

  assert.equal(db.getHoster('frdl')!.okCount, 1);
  assert.equal(db.getHoster('urleecher'), null, 'CDN を業者として起こさない');
});

// ---- 過去のジョブからの取り込み ------------------------------------------

test('履歴から成功・失敗・人間待ちを数え直す', () => {
  const hosters = [
    { key: 'dailyuploads', domains: ['dailyuploads.net'] },
    { key: 'katfile', domains: ['katfile.biz'] },
    { key: 'uploady', domains: ['uploady.io'] },
  ];
  const job = (over: Partial<Job>): Job => ({
    id: 'x', userId: 1, url: '', destDir: '', engine: null, status: 'done',
    filename: null, bytesTotal: 0, bytesDone: 0, speed: 0, error: null, externalId: null,
    seriesKey: null, volumeFrom: null, volumeTo: null,
    meta: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z',
    ...over,
  });

  const stats = countFromJobs([
    job({ url: 'https://dailyuploads.net/a', status: 'done' }),
    job({
      url: 'https://uploady.io/b',
      status: 'failed',
      // 見限った候補も 1 件 1 失敗として数える
      meta: { tried: [{ url: 'https://katfile.biz/b', error: 'Turnstile' }] },
    }),
    job({ url: 'https://katfile.biz/c', status: 'waiting_human' }),
  ], hosters);

  assert.equal(stats.get('dailyuploads')!.ok, 1);
  assert.equal(stats.get('dailyuploads')!.lastOkAt, '2026-09-09T00:00:00.000Z');
  assert.equal(stats.get('uploady')!.fail, 1);
  assert.equal(stats.get('katfile')!.fail, 1);
  assert.equal(stats.get('katfile')!.human, 1);
});

test('取り込みは一度きり (再起動で二重に積み上がらない)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-back-'));
  const db = new Db(dir);
  bootstrapHosters(db, PRIORITY);
  const user = db.createUser('tester', path.join(dir, 'downloads'));
  db.insertJob({
    id: 'j1', userId: user.id, url: 'https://dailyuploads.net/a', destDir: dir, engine: 'jd2',
    status: 'done', filename: 'a.rar', bytesTotal: 1, bytesDone: 1, speed: 0, error: null,
    externalId: null, seriesKey: null, volumeFrom: null, volumeTo: null,
    meta: {}, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  });

  // 台帳を作った後に走った 1 件目は、フラグが立っているので取り込まれない
  bootstrapHosters(db, PRIORITY);
  assert.equal(db.getHoster('dailyuploads')!.okCount, 0);
});
