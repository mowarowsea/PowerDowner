import test from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_NOT_HUMAN, isUnc } from './engines/jd2.js';

/**
 * 実機 (日本語) の JD2 が返した status。これらを人間判定と取り違えてブラウザへ回し、
 * JD2 なら素通りできる dailyuploads をブラウザが踏みに行って詰まっていた。
 */
test('保存先・ディスクの都合のスキップは人間判定ではない', () => {
  for (const s of [
    'スキップ - ファイル既存',
    '無効なダウンロードディレクトリ',
    'スキップ - ディスク空き容量無し',
    'スキップ - 再試行過多',
    'Skipped - File exists',
    'Invalid download directory',
    'Skipped - Disk full',
  ]) assert.ok(SKIP_NOT_HUMAN.test(s), s);
});

test('CAPTCHA のスキップは引き続きブラウザへ回す', () => {
  for (const s of ['スキップ - キャプチャ無視', 'Skipped - Captcha is required', 'スキップ']) {
    assert.ok(!SKIP_NOT_HUMAN.test(s), s);
  }
});

test('UNC だけを手元経由にする', () => {
  assert.ok(isUnc('\\\\192.168.3.30\\disk1_pt1\\manga'));
  assert.ok(isUnc('//nas/share'));
  assert.ok(!isUnc('Z:\\90_新悟スペース\\JDownLoaderダウンロード'));
  assert.ok(!isUnc('C:\\Users\\seamo\\PowerDowner\\downloads'));
});
