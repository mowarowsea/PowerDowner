import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from './db.js';
import { decideItem, missingVolumes } from './library.js';
import { seriesKeyOf } from './volume.js';

/** 台帳はユーザー単位なので、持ち主を 1 人用意してから始める */
function tmpDb(): Db {
  const db = new Db(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-lib-')));
  db.createUser('seamo', null);
  return db;
}

const USER = 1;
const KEY = seriesKeyOf('作品名');

/** 台帳に 1 件積む短縮形 */
function own(db: Db, from: number, to: number, status: 'have' | 'done' = 'have', userId = USER) {
  return db.insertItem({ userId, seriesKey: KEY, volumeFrom: from, volumeTo: to, status, title: '作品名' });
}

test('missingVolumes: 覆えていれば空、残れば未取得の巻を返す', () => {
  assert.deepEqual(missingVolumes({ from: 3, to: 3 }, [{ from: 1, to: 6 }]), []);
  assert.deepEqual(missingVolumes({ from: 4, to: 8 }, [{ from: 1, to: 6 }]), [7, 8]);
  assert.deepEqual(missingVolumes({ from: 7, to: 7 }, [{ from: 1, to: 6 }]), [7]);
  assert.deepEqual(missingVolumes({ from: 1, to: 3 }, []), [1, 2, 3]);
  // 歯抜けを 2 レコードで埋めている場合
  assert.deepEqual(missingVolumes({ from: 1, to: 8 }, [{ from: 1, to: 6 }, { from: 4, to: 8 }]), []);
});

test('台帳が空なら落とす', () => {
  const db = tmpDb();
  const d = decideItem(db, USER, { urls: ['https://a/1'], meta: { title: '作品名', volume: '3' } });
  assert.equal(d.kind, 'new');
});

test('1-6巻を持っている状態で第3巻が来たらスキップ', () => {
  const db = tmpDb();
  own(db, 1, 6);
  const d = decideItem(db, USER, { urls: ['https://b/3'], meta: { title: '作品名 第3巻' } });
  assert.equal(d.kind, 'skip');
  if (d.kind === 'skip') assert.match(d.reason, /所持済み/);
});

test('1-6巻を持っている状態で4-8巻が来たら、未所持が残るので落とす', () => {
  const db = tmpDb();
  own(db, 1, 6);
  const d = decideItem(db, USER, { urls: ['https://b/4-8'], meta: { title: '作品名 4-8巻' } });
  assert.equal(d.kind, 'new');
  if (d.kind === 'new') assert.deepEqual(d.missing, [7, 8]);
});

test('重ならない巻は落とす', () => {
  const db = tmpDb();
  own(db, 1, 6);
  const d = decideItem(db, USER, { urls: ['https://b/7'], meta: { title: '作品名 第7巻' } });
  assert.equal(d.kind, 'new');
});

test('未完のジョブがあれば合流させる (別サイトの同じ巻)', () => {
  const db = tmpDb();
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: 3, volumeTo: 3, status: 'pending', jobId: 'job-1', title: '作品名' });
  const d = decideItem(db, USER, { urls: ['https://b/3'], meta: { title: '作品名 第3巻' }, source: 'dryeyes:xxx' });
  assert.equal(d.kind, 'merge');
  if (d.kind === 'merge') assert.equal(d.jobId, 'job-1');
});

test('所持済みが優先される (未完ジョブがあっても、既に持っていれば落とさない)', () => {
  const db = tmpDb();
  own(db, 1, 6, 'done');
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: 3, volumeTo: 3, status: 'pending', jobId: 'job-1', title: '作品名' });
  const d = decideItem(db, USER, { urls: ['https://b/3'], meta: { title: '作品名 第3巻' } });
  assert.equal(d.kind, 'skip');
});

test('別シリーズは干渉しない', () => {
  const db = tmpDb();
  own(db, 1, 6);
  const d = decideItem(db, USER, { urls: ['https://b/3'], meta: { title: '別の作品 第3巻' } });
  assert.equal(d.kind, 'new');
});

test('巻数が読めなければ判定に参加せず落とす', () => {
  const db = tmpDb();
  own(db, 1, 6);
  const d = decideItem(db, USER, { urls: ['https://b/x'], meta: { rawText: '[著者] 作品名 読切' } });
  assert.equal(d.kind, 'new');
  if (d.kind === 'new') assert.equal(d.missing, null);
});

test('巻数を読めなかった台帳レコードは重なり判定に出てこない', () => {
  const db = tmpDb();
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: null, volumeTo: null, status: 'have', title: '作品名' });
  const d = decideItem(db, USER, { urls: ['https://b/3'], meta: { title: '作品名 第3巻' } });
  assert.equal(d.kind, 'new');
});

test('台帳はユーザーごとに分かれている (他人の所持は効かない)', () => {
  const db = tmpDb();
  db.createUser('もう一人', null);
  // ユーザー 1 が 1-6 巻を持っていても、ユーザー 2 の投入は素通しになる。
  // 保存先フォルダが別なので、片方の手元にあることは他方の手元の話にならない
  own(db, 1, 6, 'have', 1);

  assert.equal(decideItem(db, 1, { urls: ['https://a/3'], meta: { title: '作品名 第3巻' } }).kind, 'skip');
  assert.equal(decideItem(db, 2, { urls: ['https://a/3'], meta: { title: '作品名 第3巻' } }).kind, 'new');
});

test('合流も自分の台帳の中だけで起きる', () => {
  const db = tmpDb();
  db.createUser('もう一人', null);
  db.insertItem({
    userId: 1, seriesKey: KEY, volumeFrom: 7, volumeTo: 7,
    status: 'pending', jobId: 'job-1', title: '作品名',
  });

  assert.equal(decideItem(db, 1, { urls: ['https://b/7'], meta: { title: '作品名 第7巻' } }).kind, 'merge');
  // 別のユーザーの落としかけに相乗りすると、保存先が違うので手元に来ない
  assert.equal(decideItem(db, 2, { urls: ['https://b/7'], meta: { title: '作品名 第7巻' } }).kind, 'new');
});
