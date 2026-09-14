import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Db } from './db.js';
import { decideItems, missingVolumes, type ItemInput } from './library.js';
import type { PinaxConfig } from './pinax.js';
import type { Job } from './types.js';
import { parseItem, seriesKeyOf } from './volume.js';

function tmpDb(): Db {
  const db = new Db(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lib-')));
  db.createUser('seamo', null);
  db.createUser('もう一人', null);
  return db;
}

const USER = 1;
const OTHER = 2;
const KEY = seriesKeyOf('作品名');

/**
 * 棚 (pinax) の代わり。`POST /api/own` に、持っている巻から答えを作って返す。
 *
 * 読み方を本物と揃えるために `parseItem` を通している — pinax 側の `seriesKeyOf` は
 * ここからの移植で、**同じ文字列から同じキーが出ることが前提**。ここを別物にすると、
 * テストは通るのに本番で噛み合わない。
 */
async function fakeShelf(
  shelf: Record<string, { from: number; to: number }[]>,
  opts: { broken?: boolean } = {}
): Promise<{ cfg: PinaxConfig; calls: number[]; close: () => Promise<void> }> {
  const calls: number[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const items = (JSON.parse(body).items ?? []) as ItemInput['meta'][];
      calls.push(items.length);
      if (opts.broken) {
        res.writeHead(500).end('棚が転んでいます');
        return;
      }
      const answers = items.map((q) => {
        const parsed = parseItem({ title: q?.title ?? null, volume: q?.volume ?? null, rawText: q?.rawText ?? null });
        const have = shelf[parsed.seriesKey] ?? [];
        if (parsed.volumeFrom === null || parsed.volumeTo === null || have.length === 0) {
          return { parsed, owned: false, missing: null, series: [], reason: '蔵書にこの作品がありません' };
        }
        const missing = missingVolumes({ from: parsed.volumeFrom, to: parsed.volumeTo }, have);
        return {
          parsed,
          owned: missing.length === 0,
          missing,
          series: [],
          reason: missing.length === 0 ? '所持済み (棚にあります)' : `未所持: ${missing.join(',')}`,
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const port = (server.address() as { port: number }).port;
  return {
    cfg: { baseUrl: `http://127.0.0.1:${port}`, token: '', timeoutMs: 2000 },
    calls,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/** 投入 1 件分の短縮形 */
const item = (meta: ItemInput['meta']): ItemInput => ({ urls: ['https://a/x'], meta });

/** 手元のジョブを 1 件積む */
function putJob(db: Db, over: Partial<Job> = {}): Job {
  const ts = new Date().toISOString();
  const job: Job = {
    id: Math.random().toString(36).slice(2, 10),
    userId: USER,
    url: 'https://a/x',
    destDir: 'd',
    engine: null,
    status: 'downloading',
    filename: null,
    bytesTotal: 0,
    bytesDone: 0,
    speed: 0,
    error: null,
    externalId: null,
    seriesKey: KEY,
    volumeFrom: 3,
    volumeTo: 3,
    meta: {},
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
  db.insertJob(job);
  return job;
}

test('missingVolumes: 覆えていれば空、残れば未取得の巻を返す', () => {
  assert.deepEqual(missingVolumes({ from: 3, to: 3 }, [{ from: 1, to: 6 }]), []);
  assert.deepEqual(missingVolumes({ from: 4, to: 8 }, [{ from: 1, to: 6 }]), [7, 8]);
  assert.deepEqual(missingVolumes({ from: 7, to: 7 }, [{ from: 1, to: 6 }]), [7]);
  assert.deepEqual(missingVolumes({ from: 1, to: 3 }, []), [1, 2, 3]);
  // 歯抜けを 2 レコードで埋めている場合
  assert.deepEqual(missingVolumes({ from: 1, to: 8 }, [{ from: 1, to: 6 }, { from: 4, to: 8 }]), []);
});

test('棚に無ければ落とす', async () => {
  const shelf = await fakeShelf({});
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ title: '作品名', volume: '3' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

test('棚が 1-6巻 を持っていて第3巻が来たらスキップ', async () => {
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] });
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'skip');
  await shelf.close();
});

test('棚が 1-6巻 を持っていて 4-8巻 が来たら、未所持が残るので落とす', async () => {
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] });
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ title: '作品名 第4-8巻' })]);
  assert.equal(d.kind, 'new');
  assert.deepEqual(d.kind === 'new' ? d.missing : null, [7, 8]);
  await shelf.close();
});

test('別の作品は干渉しない', async () => {
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] });
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ title: '別作品 第3巻' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

/**
 * ここが逆に倒れると、棚が落ちている間の投入が全部「持っている」ことになり、
 * その巻は二度と落ちてこない。もう一度落ちる方が被害が小さい。
 */
test('棚が答えられなければ落とす', async () => {
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] }, { broken: true });
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

test('棚が止まっていても投入そのものは通る', async () => {
  const dead: PinaxConfig = { baseUrl: 'http://127.0.0.1:1', token: '', timeoutMs: 300 };
  const [d] = await decideItems(tmpDb(), dead, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
});

test('棚が未設定なら聞かずに落とす', async () => {
  const off: PinaxConfig = { baseUrl: '', token: '', timeoutMs: 300 };
  const [d] = await decideItems(tmpDb(), off, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
});

test('巻数を読めないものは棚に聞かずに落とす', async () => {
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] });
  const [d] = await decideItems(tmpDb(), shelf.cfg, USER, [item({ rawText: 'なんとか.rar' })]);
  assert.equal(d.kind, 'new');
  assert.equal(d.kind === 'new' ? d.missing : 'x', null);
  assert.deepEqual(shelf.calls, [], '重なりを判定できないものを棚に聞いても仕方がない');
  await shelf.close();
});

// ---- 棚を見ても分からないこと (落とし中・落とした直後) --------------------

test('落としている最中のジョブがあれば合流させる (別サイトの同じ巻)', async () => {
  const db = tmpDb();
  const job = putJob(db, { status: 'downloading' });
  const shelf = await fakeShelf({});
  const [d] = await decideItems(db, shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'merge');
  assert.equal(d.kind === 'merge' ? d.jobId : null, job.id);
  assert.deepEqual(shelf.calls, [], '手元で決まるものを棚に聞きに行かない');
  await shelf.close();
});

/**
 * 落とし終わってから棚のスキャンが走るまでには間がある (既定 3 時間)。
 * その隙間に同じ巻が別サイトから来ると、棚はまだ「持っていない」と答える。
 */
test('落とし終わったジョブは、棚がまだ知らなくても取得済みとして扱う', async () => {
  const db = tmpDb();
  putJob(db, { status: 'done' });
  const shelf = await fakeShelf({});
  const [d] = await decideItems(db, shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'skip');
  await shelf.close();
});

test('失敗・中止のジョブは判定に参加しない (消さなくても落とし直せる)', async () => {
  const db = tmpDb();
  putJob(db, { status: 'failed' });
  putJob(db, { status: 'canceled' });
  const shelf = await fakeShelf({});
  const [d] = await decideItems(db, shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

test('巻数を読めなかったジョブは重なり判定に出てこない', async () => {
  const db = tmpDb();
  putJob(db, { status: 'downloading', volumeFrom: null, volumeTo: null });
  const shelf = await fakeShelf({});
  const [d] = await decideItems(db, shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

/**
 * 合流は自分のジョブの中だけで起きる。他人のダウンロード中ジョブに相乗りしても、
 * 落ちる先はその人のフォルダで、こちらの手元には来ない。
 */
test('他人のジョブには合流しない', async () => {
  const db = tmpDb();
  putJob(db, { status: 'downloading', userId: OTHER });
  const shelf = await fakeShelf({});
  const [d] = await decideItems(db, shelf.cfg, USER, [item({ title: '作品名 第3巻' })]);
  assert.equal(d.kind, 'new');
  await shelf.close();
});

// ---- まとめて聞く ----------------------------------------------------------

test('棚への往復は投入の件数によらず 1 回', async () => {
  const db = tmpDb();
  putJob(db, { status: 'downloading', volumeFrom: 9, volumeTo: 9 });
  const shelf = await fakeShelf({ [KEY]: [{ from: 1, to: 6 }] });

  const decisions = await decideItems(db, shelf.cfg, USER, [
    item({ title: '作品名 第3巻' }),   // 棚が持っている
    item({ title: '作品名 第7巻' }),   // 棚に無い
    item({ title: '作品名 第9巻' }),   // 落とし中 (棚に聞かない)
    item({ rawText: '読めない.rar' }), // 巻数不明 (棚に聞かない)
  ]);

  assert.deepEqual(decisions.map((d) => d.kind), ['skip', 'new', 'merge', 'new']);
  assert.deepEqual(shelf.calls, [2], '手元で決まらなかった 2 件だけをまとめて聞く');
  await shelf.close();
});

test('答えは投入と同じ並びで返る', async () => {
  const shelf = await fakeShelf({
    [seriesKeyOf('あ')]: [{ from: 1, to: 1 }],
    [seriesKeyOf('う')]: [{ from: 1, to: 1 }],
  });
  const decisions = await decideItems(tmpDb(), shelf.cfg, USER, [
    item({ title: 'あ 第1巻' }),
    item({ title: 'い 第1巻' }),
    item({ title: 'う 第1巻' }),
  ]);
  assert.deepEqual(decisions.map((d) => d.kind), ['skip', 'new', 'skip']);
  await shelf.close();
});
