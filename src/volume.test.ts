import test from 'node:test';
import assert from 'node:assert/strict';
import { parseItem, seriesKeyOf } from './volume.js';

const vol = (title: string) => {
  const r = parseItem({ title });
  return [r.volumeFrom, r.volumeTo];
};

test('単巻を読む', () => {
  assert.deepEqual(vol('作品名 第3巻'), [3, 3]);
  assert.deepEqual(vol('作品名 3巻'), [3, 3]);
  assert.deepEqual(vol('作品名 第03巻'), [3, 3]);
  assert.deepEqual(vol('作品名 第12話'), [12, 12]);
  assert.deepEqual(vol('作品名 vol.3'), [3, 3]);
});

test('v01 形式 (vol の省略形) を読む', () => {
  // ファイル名でよくある表記。区切りが _ や . でも効く必要がある
  assert.deepEqual(vol('Isekai machikoba muso Shinrai v01-02s.rar'), [1, 2]);
  assert.deepEqual(vol('Isekai_machikoba_muso_Shinrai_v03-04s.rar'), [3, 4]);
  assert.deepEqual(vol('Isekai machikoba muso Shinrai v06.rar'), [6, 6]);
});

test('単語の途中の v は巻数と読まない', () => {
  // Novel の v を拾うと、ありもしない巻数が付いてしまう
  assert.deepEqual(vol('Advent Novel v02.zip'), [2, 2]);
  assert.deepEqual(vol('Advent Novel.zip'), [null, null]);
});

test('全角数字を読む (NFKC)', () => {
  assert.deepEqual(vol('作品名 第３巻'), [3, 3]);
});

test('範囲を読む', () => {
  assert.deepEqual(vol('作品名 1-6巻'), [1, 6]);
  assert.deepEqual(vol('作品名 第1巻-第6巻'), [1, 6]);
  assert.deepEqual(vol('作品名 vol.1-6'), [1, 6]);
});

test('波ダッシュと全角チルダの両方を範囲区切りとして読む', () => {
  // U+301C 波ダッシュ。NFKC では畳まれないので文字クラスに直接必要
  assert.deepEqual(vol('作品名 1〜6巻'), [1, 6]);
  // U+FF5E 全角チルダ。NFKC で ~ になる
  assert.deepEqual(vol('作品名 1～6巻'), [1, 6]);
});

test('全N巻・完結N巻は 1..N とみなす', () => {
  assert.deepEqual(vol('作品名 全6巻'), [1, 6]);
  assert.deepEqual(vol('作品名 完結12巻'), [1, 12]);
});

test('巻キーワードを伴わない数字は拾わない', () => {
  assert.deepEqual(vol('作品名 1920-1080'), [null, null]);
  assert.deepEqual(vol('作品名 2024'), [null, null]);
  assert.deepEqual(vol('作品名'), [null, null]);
});

test('巻数は後ろから探す (タイトル内の数字を誤読しない)', () => {
  assert.deepEqual(vol('3月のライオン 第5巻'), [5, 5]);
  assert.deepEqual(vol('11-eyes 1-3巻'), [1, 3]);
});

test('ありえない範囲は無効にする', () => {
  assert.deepEqual(vol('作品名 6-1巻'), [null, null]);   // 逆順
  assert.deepEqual(vol('作品名 1-2024巻'), [null, null]); // 幅が広すぎる
});

test('DryEyes が volume を明示した時は単位キーワードを要求しない', () => {
  const one = parseItem({ title: '作品名', volume: '3' });
  assert.deepEqual([one.volumeFrom, one.volumeTo], [3, 3]);

  const padded = parseItem({ title: '作品名', volume: '03' });
  assert.deepEqual([padded.volumeFrom, padded.volumeTo], [3, 3]);

  const paren = parseItem({ title: '作品名', volume: '(3)' });
  assert.deepEqual([paren.volumeFrom, paren.volumeTo], [3, 3]);

  const range = parseItem({ title: '作品名', volume: '1-6' });
  assert.deepEqual([range.volumeFrom, range.volumeTo], [1, 6]);

  const unit = parseItem({ title: '作品名', volume: '第03巻' });
  assert.deepEqual([unit.volumeFrom, unit.volumeTo], [3, 3]);

  const num = parseItem({ title: '作品名', volume: 3 });
  assert.deepEqual([num.volumeFrom, num.volumeTo], [3, 3]);
});

test('volume が無ければ title、それも無ければ rawText から探す', () => {
  const fromTitle = parseItem({ title: '作品名 第4巻', rawText: '[著者] 作品名 第4巻' });
  assert.deepEqual([fromTitle.volumeFrom, fromTitle.volumeTo], [4, 4]);

  const fromRaw = parseItem({ title: null, rawText: '[著者] 作品名 第7巻' });
  assert.deepEqual([fromRaw.volumeFrom, fromRaw.volumeTo], [7, 7]);
});

test('seriesKey は巻数を落とすので、同じ作品の別巻が同じキーになる', () => {
  assert.equal(seriesKeyOf('作品名 第3巻'), seriesKeyOf('作品名 第4巻'));
  assert.equal(seriesKeyOf('作品名 第3巻'), seriesKeyOf('作品名 1-6巻'));
});

test('seriesKey は表記ゆれを吸収する', () => {
  assert.equal(seriesKeyOf('作品名 ＡＢＣ'), seriesKeyOf('作品名 abc'));
  assert.equal(seriesKeyOf('作品名　【完結】'), seriesKeyOf('作品名 完結'));
  assert.equal(seriesKeyOf('作品名 - サブ'), seriesKeyOf('作品名サブ'));
});

test('seriesKey はサブタイトルを削らない (誤合流より再取得を選ぶ)', () => {
  assert.notEqual(seriesKeyOf('作品名'), seriesKeyOf('作品名 〜サブタイトル〜'));
});

test('rawText しか無く巻数も取れない時は範囲判定に参加しない', () => {
  const r = parseItem({ rawText: '[著者] 読切タイトル' });
  assert.equal(r.volumeFrom, null);
  assert.equal(r.volumeTo, null);
  assert.notEqual(r.seriesKey, '');
});
