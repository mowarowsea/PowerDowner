import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  fitPath, formatVolume, parseFilename, planName, sanitizeSegment, splitFilename, uniqueName,
} from './naming.js';
import { seriesKeyOf } from './volume.js';

test('拡張子・分割連番・同名回避の連番を割る', () => {
  assert.deepEqual(splitFilename('作品名 第03巻.rar'), { stem: '作品名 第03巻', part: '', ext: '.rar' });
  assert.deepEqual(splitFilename('作品名 第03巻.part2.rar'), { stem: '作品名 第03巻', part: '.part2', ext: '.rar' });
  // .r00 / .001 は拡張子そのものが連番。part に回すと拡張子が消える
  assert.deepEqual(splitFilename('作品名 第03巻.r00'), { stem: '作品名 第03巻', part: '', ext: '.r00' });
  assert.deepEqual(splitFilename('作品名 第03巻.001'), { stem: '作品名 第03巻', part: '', ext: '.001' });
  assert.deepEqual(splitFilename('作品名 第03巻 (2).rar'), { stem: '作品名 第03巻', part: '', ext: '.rar' });
});

test('著者を作品名から外して読み戻す', () => {
  const p = parseFilename('[あだち充] タッチ 第03巻.rar');
  assert.equal(p.author, 'あだち充');
  assert.equal(p.title, 'タッチ');
  assert.deepEqual([p.volumeFrom, p.volumeTo], [3, 3]);
  assert.equal(p.ext, '.rar');
});

/**
 * ここが噛み合わないと、棚 (pinax) にあるのに DryEyes からの投入を弾けず二重に落とす。
 * 著者を作品名に残していた頃はここで割れていた (key=あだち充タッチ vs タッチ)。
 *
 * **書く側 (ここ) と読む側 (pinax の naming.ts) は同じ規則でなければならない。**
 * 棚に並ぶファイル名を書いているのは PowerDowner なので、片方だけ直すと
 * 自分で置いたファイルを棚が別の作品として読む。
 */
test('自分で書いた名前と、DryEyes の title からキーが一致する', () => {
  const p = parseFilename('[あだち充] タッチ 第03巻.rar');
  assert.equal(seriesKeyOf(p.title), seriesKeyOf('タッチ'));
  assert.equal(p.author, 'あだち充');
});

test('巻数は 2 桁 0 埋め。3 桁以上はそのまま伸ばす', () => {
  assert.equal(formatVolume(3, 3), '第03巻');
  assert.equal(formatVolume(1, 6), '第01-06巻');
  assert.equal(formatVolume(200, 200), '第200巻');
  assert.equal(formatVolume(12, 12, '話'), '第12話');
});

test('ファイル名に使えない文字を全角へ倒す', () => {
  assert.equal(sanitizeSegment('作品名: 第2部/完'), '作品名： 第2部／完');
  assert.equal(sanitizeSegment('どうして?'), 'どうして？');
  // 末尾のピリオドと空白は Windows が黙って落とすので、こちらで落としておく
  assert.equal(sanitizeSegment('作品名... '), '作品名');
  // 予約名は拡張子を付けても掴めない
  assert.equal(sanitizeSegment('CON'), 'CON_');
  assert.equal(sanitizeSegment('   '), null);
});

test('作品フォルダとファイル名を組み立てる', () => {
  const plan = planName('dl_9f3a2b.rar', { author: 'あだち充', title: 'タッチ', volumeFrom: 3, volumeTo: 3 });
  assert.equal(plan.folder, '[あだち充] タッチ');
  assert.equal(plan.file, '[あだち充] タッチ 第03巻.rar');

  const range = planName('dl.rar', { author: 'あだち充', title: 'タッチ', volumeFrom: 1, volumeTo: 6 });
  assert.equal(range.file, '[あだち充] タッチ 第01-06巻.rar');
});

test('著者が無ければ [] を付けない', () => {
  const plan = planName('dl.rar', { title: 'タッチ', volumeFrom: 3, volumeTo: 3 });
  assert.equal(plan.folder, 'タッチ');
  assert.equal(plan.file, 'タッチ 第03巻.rar');
});

test('メタが無ければ元のファイル名から読む', () => {
  const plan = planName('[あだち充] タッチ 第3巻.rar');
  assert.equal(plan.file, '[あだち充] タッチ 第03巻.rar');
});

test('分割書庫の連番は残す (均すと片方が消えて解凍できない)', () => {
  const one = planName('[著者] 作品名 第03巻.part1.rar');
  const two = planName('[著者] 作品名 第03巻.part2.rar');
  assert.equal(one.file, '[著者] 作品名 第03巻.part1.rar');
  assert.equal(two.file, '[著者] 作品名 第03巻.part2.rar');
  assert.notEqual(one.file, two.file);
});

test('「話」で書かれていたものを「巻」に書き換えない', () => {
  const plan = planName('[著者] 作品名 第12話.zip');
  assert.equal(plan.file, '[著者] 作品名 第12話.zip');
});

test('巻数が読めなければ名前は変えない (フォルダには入れる)', () => {
  const plan = planName('rsdjf1me5yac.rar', { author: '著者', title: '作品名' });
  assert.equal(plan.keepName, true);
  assert.equal(plan.file, 'rsdjf1me5yac.rar');
  assert.equal(plan.folder, '[著者] 作品名');
});

test('作品名も分からなければ何もしない', () => {
  const plan = planName('rsdjf1me5yac.rar');
  assert.equal(plan.folder, null);
  assert.equal(plan.file, 'rsdjf1me5yac.rar');
});

test('同じ名前があれば連番を付ける。連番は読み戻す時に落ちる', () => {
  const taken = new Set([
    path.join('d', '[著者] 作品名 第03巻.rar'),
    path.join('d', '[著者] 作品名 第03巻 (2).rar'),
  ]);
  const got = uniqueName('d', '[著者] 作品名 第03巻.rar', (p) => taken.has(p));
  assert.equal(got, '[著者] 作品名 第03巻 (3).rar');

  // 連番付きでも巻数とキーは変わらない (ここが崩れると棚と噛み合わなくなる)
  const c = parseFilename(got);
  assert.deepEqual([c.volumeFrom, c.volumeTo], [3, 3]);
  assert.equal(seriesKeyOf(c.title), seriesKeyOf('作品名'));
});

test('分割書庫の連番より後ろに連番を付ける', () => {
  const taken = new Set([path.join('d', 'x 第03巻.part1.rar')]);
  assert.equal(uniqueName('d', 'x 第03巻.part1.rar', (p) => taken.has(p)), 'x 第03巻 (2).part1.rar');
});

test('パスが長すぎるなら作品名を削って収める', () => {
  const base = '\\\\192.168.3.30\\disk1_pt1\\manga';
  const title = 'あ'.repeat(120);
  const plan = planName('dl.rar', { author: '著者', title, volumeFrom: 1, volumeTo: 1 });
  const fitted = fitPath(base, plan, { author: '著者', title });
  const full = path.join(base, fitted.folder ?? '', fitted.file);
  assert.ok(full.length <= 240, `収まっていない: ${full.length}`);
  // 削っても巻数と拡張子は残す
  assert.ok(fitted.file.endsWith('第01巻.rar'), fitted.file);
});
