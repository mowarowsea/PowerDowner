import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from './db.js';
import { decideItem, diagnoseItems, missingVolumes } from './library.js';
import type { Job } from './types.js';
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

// ---- 管理画面向けの診断 ---------------------------------------------------
// 台帳は「持っている」と言い切る場所なので、間違った行は黙ってその巻を落とせなくする。
// 画面から直せるようにする前に、どれが怪しいのかを言えないと直しようがない。

/** ジョブの引き当てだけを差し替える。ここで見たいのは台帳の側の見立て */
const jobLookup = (jobs: Partial<Job>[]) => (id: string): Job | null =>
  (jobs.find((j) => j.id === id) as Job | undefined) ?? null;

test('診断: 何も問題の無い行には印が付かない', () => {
  const db = tmpDb();
  own(db, 1, 6, 'have');
  const [d] = diagnoseItems(db.listItems({ userId: USER }), () => null);
  assert.deepEqual(d.warnings, []);
  assert.equal(d.job, null);
});

test('診断: pending のままジョブが消えた行を捕まえる', () => {
  const db = tmpDb();
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: 7, volumeTo: 7, status: 'pending', jobId: 'gone', title: '作品名' });
  const [d] = diagnoseItems(db.listItems({ userId: USER }), () => null);
  // この行が残っている限り、同じ巻の投入は全部ここへ合流して何も落ちない
  assert.equal(d.warnings.length, 1);
  assert.match(d.warnings[0], /ジョブが残っていません/);
});

test('診断: 失敗で終わったジョブを指したままの行を捕まえる', () => {
  const db = tmpDb();
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: 7, volumeTo: 7, status: 'pending', jobId: 'j1', title: '作品名' });
  const [d] = diagnoseItems(
    db.listItems({ userId: USER }),
    jobLookup([{ id: 'j1', status: 'failed', filename: null, error: '全滅' }])
  );
  assert.match(d.warnings[0], /失敗で終わっています/);
  assert.equal(d.job?.status, 'failed');
});

test('診断: 走っている最中のジョブは問題にしない', () => {
  const db = tmpDb();
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: 7, volumeTo: 7, status: 'pending', jobId: 'j1', title: '作品名' });
  const [d] = diagnoseItems(
    db.listItems({ userId: USER }),
    jobLookup([{ id: 'j1', status: 'downloading', filename: 'x.rar', error: null }])
  );
  assert.deepEqual(d.warnings, []);
});

test('診断: 作品名が無い行と巻数を読めていない行を捕まえる', () => {
  const db = tmpDb();
  // 作品名が分からないまま投入されると、キーが生の文字列 (ミラーのホスト名込み) から作られる
  db.insertItem({ userId: USER, seriesKey: 'v0102rarkatfileturbobit', volumeFrom: 1, volumeTo: 2, status: 'done', title: null, rawText: 'v01-02.rar katfile turbobit' });
  db.insertItem({ userId: USER, seriesKey: KEY, volumeFrom: null, volumeTo: null, status: 'have', title: '作品名' });

  const found = diagnoseItems(db.listItems({ userId: USER }), () => null);
  const noTitle = found.find((d) => d.title === null)!;
  const noVolume = found.find((d) => d.volumeFrom === null)!;
  assert.match(noTitle.warnings.join(), /別サイトから来た同じ巻と噛み合いません/);
  assert.match(noVolume.warnings.join(), /重複の判定に参加していません/);
});

test('診断: ファイル名がそのまま作品名になっている行を捕まえる', () => {
  const db = tmpDb();
  // 作品名として入ってはいるが中身はファイル名。キーが落とすのは巻数だけなので、
  // 拡張子もミラーのホスト名もキーに残り、他所から来た同じ巻と噛み合わない
  db.insertItem({
    userId: USER, seriesKey: 'x', volumeFrom: 1, volumeTo: 2, status: 'have',
    title: 'Isekai machikoba muso v01-02s.rar katfile rapidgator',
  });
  const [d] = diagnoseItems(db.listItems({ userId: USER }), () => null);
  assert.match(d.warnings.join(), /作品名にファイル名が入っています/);

  // 普通の作品名は疑わない
  const ok = tmpDb();
  own(ok, 1, 1);
  assert.deepEqual(diagnoseItems(ok.listItems({ userId: USER }), () => null)[0].warnings, []);
});

test('診断: 同じ巻を指す行が 2 つあれば両方に印が付く', () => {
  const db = tmpDb();
  const a = own(db, 1, 6);
  const b = own(db, 3, 3);
  const found = diagnoseItems(db.listItems({ userId: USER }), () => null);
  assert.match(found.find((d) => d.id === a.id)!.warnings.join(), new RegExp(`id ${b.id}`));
  assert.match(found.find((d) => d.id === b.id)!.warnings.join(), new RegExp(`id ${a.id}`));
});

test('診断: 他人の同じ巻は重複と見なさない (台帳はユーザー単位)', () => {
  const db = tmpDb();
  db.createUser('もう一人', null);
  own(db, 1, 6, 'have', 1);
  own(db, 1, 6, 'have', 2);
  const found = diagnoseItems(db.listItems(), () => null);
  assert.deepEqual(found.flatMap((d) => d.warnings), []);
});
