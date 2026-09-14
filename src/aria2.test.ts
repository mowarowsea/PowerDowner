import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { outNameFor } from './engines/aria2.js';

const DIR = path.join('Z:', '90_新僧スペース', 'JDownloaderダウンロード');
/** 手元にあることにするファイル群 */
const having = (...names: string[]) => {
  const set = new Set(names.map((n) => path.join(DIR, n)));
  return (p: string): boolean => set.has(p);
};

test('同名が無ければそのままの名前で落とす', () => {
  assert.equal(outNameFor(DIR, 'Goblin_Slayer_Manga_v14.rar', having()), 'Goblin_Slayer_Manga_v14.rar');
});

/**
 * ここが抜けていて aria2 が code 13 (file already exists) で弾いていた。
 * 連番は投入時に決めないと、1 バイトも落ちないまま失敗する。
 */
test('同名があれば連番を付けて落とす', () => {
  const exists = having('Goblin_Slayer_Manga_v14.rar');
  assert.equal(outNameFor(DIR, 'Goblin_Slayer_Manga_v14.rar', exists), 'Goblin_Slayer_Manga_v14 (2).rar');
});

test('連番付きも埋まっていれば次の番号まで送る', () => {
  const exists = having('本.rar', '本 (2).rar', '本 (3).rar');
  assert.equal(outNameFor(DIR, '本.rar', exists), '本 (4).rar');
});

test('分割書庫の連番は拡張子の手前に残す', () => {
  const exists = having('本.part2.rar');
  assert.equal(outNameFor(DIR, '本.part2.rar', exists), '本 (2).part2.rar');
});

test('落としかけ (*.aria2 が残っている) は同じ名前で続きから', () => {
  const exists = having('本.rar', '本.rar.aria2');
  assert.equal(outNameFor(DIR, '本.rar', exists), '本.rar');
});

test('他所が落としかけの名前は避ける', () => {
  // 本 (2) は本体こそ無いが *.aria2 が居る = 誰かが掴んでいる
  const exists = having('本.rar', '本 (2).rar.aria2');
  assert.equal(outNameFor(DIR, '本.rar', exists), '本 (3).rar');
});

test('書庫以外は拡張子を保ったまま連番を挟む', () => {
  assert.equal(outNameFor(DIR, '動画.mp4', having('動画.mp4')), '動画 (2).mp4');
  assert.equal(outNameFor(DIR, '動画 (2).mp4', having('動画 (2).mp4')), '動画 (3).mp4');
  assert.equal(outNameFor(DIR, '拡張子なし', having('拡張子なし')), '拡張子なし (2)');
});
