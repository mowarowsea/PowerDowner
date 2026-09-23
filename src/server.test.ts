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
import { parseItem, seriesKeyOf } from './volume.js';
import type { PinaxConfig } from './pinax.js';
import { missingVolumes } from './library.js';
import http from 'node:http';

const TOKEN = 'test-token';

/**
 * エンジンには触らずに HTTP の配線だけを見る。
 * router.resolve を解決しない Promise にしてあるので、投入されたジョブは resolving で止まり、
 * 外へは 1 本も通信が出ない (合流の検証もこの状態で安定する)。
 */
async function harness(pinax?: PinaxConfig) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-srv-'));
  const dest = path.join(dir, 'downloads');
  // 棚を渡さないテストは繋ぎに行かない。**本物の config.json を読んでいるので、
  // ここで潰さないと手元で動いている pinax にテストが話しかける**
  const cfg = {
    ...loadConfig(),
    dataDir: dir,
    apiToken: TOKEN,
    pinax: pinax ?? { baseUrl: '', token: '', timeoutMs: 500 },
  };
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

test('正しいトークンなら投入され、巻の解釈がジョブに焼かれる', async () => {
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

  // 台帳は無い。「同じ巻が別サイトから来た」の判定はジョブ自身が持つ
  const job = db.getJob(body.created[0].id);
  assert.equal(job?.seriesKey, seriesKeyOf('作品名'));
  assert.deepEqual([job?.volumeFrom, job?.volumeTo], [3, 3]);
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
  const mergedFrom = db.getJob(jobId)?.meta.mergedFrom as { source: string }[];
  assert.equal(mergedFrom.length, 1);
  assert.equal(mergedFrom[0].source, 'dryeyes:watch-2');
  assert.equal(db.listJobs().length, 1);
  await app.close();
});

/**
 * 同じ巻を別ページで見つけると、DryEyes は区切り文字だけ違うファイル名で 2 件送ってくる。
 * 1 回の投入の中なので、手元にはまだ 1 件もジョブが無い。
 */
test('1 回の投入に同じ巻が 2 件混ざっていても、ジョブは 1 本', async () => {
  const { app, db, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      userId: user.id,
      items: [
        item('作品名', ['https://a.example/3-5'], { rawText: 'Sakuhin_Mei_v03-05s.rar' }),
        { ...item('作品名', ['https://c.example/3-5'], { rawText: 'Sakuhin Mei v03-05s.rar' }), sourceKey: 'watch-1:def' },
        item('作品名', ['https://a.example/6'], { rawText: 'Sakuhin_Mei_v06.rar' }),
      ],
    },
  });
  const body = res.json();
  assert.equal(body.created.length, 2, '3-5 巻と 6 巻の 2 本');
  assert.equal(body.merged.length, 1);
  assert.equal(body.merged[0].jobId, body.created[0].id);
  // 投入元が結果を突き合わせられるよう、寄せた方の sourceKey が返る
  assert.equal(body.merged[0].sourceKey, 'watch-1:def');
  // 2 件目の URL は 1 本目のミラー候補になっている
  assert.deepEqual(db.getJob(body.created[0].id)?.meta.mirrors, ['https://c.example/3-5']);
  assert.equal(db.listJobs().length, 2);
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

// ---- 画面から作品として登録する (DryEyes を通さない) ----------------------
// 完結した作品や 1 冊だけのシリーズのために、URL と作者・作品名を画面で紐づける。
// 通る道は DryEyes からの items と同じ (台帳・リネーム・ミラーを 2 通りにしない)。

test('画面から作品として登録できる。巻数を書いた時、貼った URL は同じ巻のミラーになる', async () => {
  const { app, db, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: {
      userId: user.id,
      urls: ['https://a.example/x.rar', 'https://b.example/x.rar'],
      item: { title: '完結作品', author: '著者', volume: '3' },
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.created.length, 1);
  assert.equal(body.created[0].url, 'https://a.example/x.rar');
  assert.deepEqual(body.created[0].meta.mirrors, ['https://b.example/x.rar']);
  // リネームが作者と作品名を使えるよう、投入メタとして残る
  assert.equal(body.created[0].meta.item.title, '完結作品');
  assert.equal(body.created[0].meta.item.author, '著者');

  // 巻の解釈が焼かれるので、あとで DryEyes から同じ巻が来ても二重に落とさない
  const job = db.getJob(body.created[0].id);
  assert.equal(job?.seriesKey, seriesKeyOf('完結作品'));
  assert.deepEqual([job?.volumeFrom, job?.volumeTo], [3, 3]);
  await app.close();
});

test('巻数を空けたら 1 行 1 巻。巻数は URL のファイル名から読む', async () => {
  const { app, db, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: {
      userId: user.id,
      urls: ['https://a.example/f/abc/Series_v01.rar.html', 'https://a.example/f/def/Series_v02.rar.html'],
      item: { title: '古い作品' },
    },
  });
  const body = res.json();
  assert.equal(body.created.length, 2);
  const vols = body.created.map((j: { id: string }) => {
    const e = db.getJob(j.id);
    return [e?.volumeFrom, e?.volumeTo];
  });
  assert.deepEqual(vols, [[1, 1], [2, 2]]);
  // 巻が違うだけで同じ作品なので、キーは同じ
  assert.equal(db.getJob(body.created[0].id)?.seriesKey, seriesKeyOf('古い作品'));
  await app.close();
});

test('画面から作品として登録しても、棚が持っている巻は落とさない', async () => {
  const shelf = await fakeShelf({ [seriesKeyOf('完結作品')]: [{ from: 1, to: 7 }] });
  const { app, user } = await harness(shelf.cfg);

  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { userId: user.id, urls: ['https://a.example/x.rar'], item: { title: '完結作品', volume: '3' } },
  });
  // 1 件も落とさないのは正常な結果なので 200。理由は画面に出す
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /所持済み/);
  await app.close();
  await shelf.close();
});

test('作品名が無ければ今までどおりの urls 投入のまま', async () => {
  const { app, db, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    payload: { userId: user.id, urls: ['https://a.example/x.rar'], item: { title: '  ', author: '著者' } },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.jobs.length, 1);
  // 巻の解釈は焼かれない (作品が分からないものを判定に参加させると、別作品を巻き込む)
  assert.equal(db.getJob(body.jobs[0].id)?.seriesKey, null);
  await app.close();
});

// ---- 棚 (pinax) への問い合わせ --------------------------------------------

/**
 * 棚の代わり。読み方を本物と揃えるために parseItem を通す
 * (pinax の seriesKeyOf はここからの移植で、同じ文字列から同じキーが出るのが前提)。
 */
async function fakeShelf(shelf: Record<string, { from: number; to: number }[]>) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const items = (JSON.parse(body).items ?? []) as Record<string, string | null>[];
      const answers = items.map((q) => {
        const parsed = parseItem({ title: q?.title ?? null, volume: q?.volume ?? null, rawText: q?.rawText ?? null });
        const have = shelf[parsed.seriesKey] ?? [];
        if (parsed.volumeFrom === null || parsed.volumeTo === null || have.length === 0) {
          return { parsed, owned: false, missing: null, series: [], reason: '蔵書にこの作品がありません' };
        }
        const missing = missingVolumes({ from: parsed.volumeFrom, to: parsed.volumeTo }, have);
        return {
          parsed, owned: missing.length === 0, missing, series: [],
          reason: missing.length === 0 ? '所持済み (棚にあります)' : `未所持: ${missing.join(',')}`,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  return {
    cfg: { baseUrl: `http://127.0.0.1:${port}`, token: '', timeoutMs: 2000 } as PinaxConfig,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

test('棚が持っている巻は投入されない', async () => {
  const shelf = await fakeShelf({ [seriesKeyOf('作品名')]: [{ from: 1, to: 6 }] });
  const { app, user } = await harness(shelf.cfg);

  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://a.example/3'])] },
  });
  const body = res.json();
  assert.equal(body.created.length, 0);
  assert.equal(body.skipped.length, 1);
  assert.match(body.skipped[0].reason, /所持済み/);
  await app.close();
  await shelf.close();
});

/**
 * DryEyes が候補一覧に「もう持っている」の印を出すために叩く口。
 * **答えの出どころが台帳から棚に変わっても、返す形は変えていない** —
 * 聞く側から見れば聞くことも答えも同じなので、向こうを直さずに済ませる。
 */
test('items/check は投入せずに判定だけ返す', async () => {
  const shelf = await fakeShelf({ [seriesKeyOf('作品名')]: [{ from: 1, to: 6 }] });
  const { app, db, user } = await harness(shelf.cfg);

  const res = await app.inject({
    method: 'POST', url: '/api/items/check',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: {
      userId: user.id,
      items: [
        item('作品名 第3巻', ['https://a.example/3']),
        item('作品名 第9巻', ['https://a.example/9']),
      ],
    },
  });
  assert.equal(res.statusCode, 200);
  const [owned, notYet] = res.json().results;

  assert.equal(owned.state, 'skip');
  assert.match(owned.reason, /所持済み/);
  assert.equal(owned.sourceKey, 'watch-1:abc');
  assert.equal(owned.seriesKey, seriesKeyOf('作品名'));
  assert.deepEqual([owned.volumeFrom, owned.volumeTo], [3, 3]);

  assert.equal(notYet.state, 'new');
  assert.equal(notYet.reason, null);

  // 調べただけで何も起きない
  assert.equal(db.listJobs().length, 0);
  await app.close();
  await shelf.close();
});

test('items/check はトークンが無いと 401', async () => {
  const { app, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/items/check',
    payload: { userId: user.id, items: [item('作品名 第3巻', ['https://a.example/3'])] },
  });
  assert.equal(res.statusCode, 401);
  await app.close();
});

test('サイト制限待ちになったら、候補が残っていれば待たずに次の候補へ移る', async () => {
  const { app, db, queue, user } = await harness();
  const res = await app.inject({
    method: 'POST', url: '/api/jobs',
    headers: { authorization: `Bearer ${TOKEN}` },
    payload: { userId: user.id, items: [item('作品名 第4巻', ['https://a.example/4', 'https://b.example/4'])] },
  });
  const jobId = res.json().created[0].id;

  // 候補が残っている → 移して true (エンジンはジョブを手放す)
  assert.equal(queue.onSiteWait(jobId, Date.now() + 600_000, 'サイト側が応答しません (HTTP 521)'), true);
  const moved = db.getJob(jobId)!;
  assert.equal(moved.url, 'https://b.example/4');
  assert.deepEqual(moved.meta.mirrors, []);
  // 見送った候補は tried に落とす。末尾へ回すと全候補が待ちのとき巡回し続ける
  assert.deepEqual((moved.meta.tried as { url: string }[]).map((t) => t.url), ['https://a.example/4']);

  // 最後の候補 → 従来どおり待つ
  assert.equal(queue.onSiteWait(jobId, Date.now() + 600_000, 'サイト側が応答しません (HTTP 521)'), false);
  const waiting = db.getJob(jobId)!;
  assert.equal(waiting.status, 'waiting_site');
  assert.equal(waiting.url, 'https://b.example/4');
  await app.close();
});
