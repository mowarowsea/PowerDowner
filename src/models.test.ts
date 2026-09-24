import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findExisting, guessDir, imageExtOf, listCandidates, previewNameFor, relToRoot, resolveModelDir,
} from './models.js';
import { isCivitaiUrl, thumbUrl } from './resolvers/civitai.js';

const CKPT = ['StableDiffusion', 'StableDiffusion\\anime', 'StableDiffusion\\semi-real'];
const LORA = ['Lora', 'Lora\\Character', 'Lora\\Clothes', 'Lora\\Pony', 'Lora\\Pose'];

test('チェックポイントはタグでアニメ / リアルを当てる', () => {
  assert.equal(guessDir(CKPT, { tags: ['nsfw', 'base model', 'anime', '2d'], baseModel: 'Illustrious', lastUsed: null }), 'StableDiffusion\\anime');
  assert.equal(guessDir(CKPT, { tags: ['base model', 'photorealistic', 'realistic'], baseModel: 'SDXL 1.0', lastUsed: null }), 'StableDiffusion\\semi-real');
});

test('ベースモデル名のフォルダはタグより先に当たる', () => {
  assert.equal(guessDir(LORA, { tags: ['character', 'anime'], baseModel: 'Pony', lastUsed: null }), 'Lora\\Pony');
  assert.equal(guessDir(LORA, { tags: ['character', 'anime'], baseModel: 'Illustrious', lastUsed: null }), 'Lora\\Character');
  assert.equal(guessDir(LORA, { tags: ['clothing', 'outfit'], baseModel: 'Illustrious', lastUsed: null }), 'Lora\\Clothes');
});

test('タグで当たらなければ前回のフォルダ、それも無ければ種類のフォルダ', () => {
  assert.equal(guessDir(LORA, { tags: ['style'], baseModel: 'SDXL 1.0', lastUsed: 'Lora\\Pose' }), 'Lora\\Pose');
  assert.equal(guessDir(LORA, { tags: ['style'], baseModel: 'SDXL 1.0', lastUsed: 'Lora\\消したフォルダ' }), 'Lora');
  assert.equal(guessDir([], { tags: [], baseModel: '', lastUsed: null }), null);
});

test('画像の拡張子は Content-Type を正とする (CivitAI は .jpeg の URL で png を返す)', () => {
  assert.equal(imageExtOf('image/png', 'https://image.civitai.com/x/original=true/1.jpeg'), '.png');
  assert.equal(imageExtOf('image/jpeg', 'https://x/1.png'), '.jpg');
  assert.equal(imageExtOf(null, 'https://x/1.jpeg'), '.jpg');
  assert.equal(imageExtOf('application/octet-stream', 'https://x/1.webp?a=1'), '.webp');
  assert.equal(imageExtOf(null, 'https://x/noext'), '.png');
});

test('プレビューはモデルと同じ名前', () => {
  assert.equal(previewNameFor('reedXXXIllustrious_v160.safetensors', '.png'), 'reedXXXIllustrious_v160.png');
  assert.equal(previewNameFor('a.b (2).safetensors', '.jpg'), 'a.b (2).jpg');
});

test('保存先は根からの相対か絶対パス。根の外へは出さない', () => {
  const root = path.resolve('C:\\SD\\models');
  assert.equal(resolveModelDir(root, 'Lora\\Pony'), path.join(root, 'Lora', 'Pony'));
  assert.equal(resolveModelDir(root, 'D:\\other'), path.normalize('D:\\other'));
  assert.throws(() => resolveModelDir(root, '..\\..\\Windows'));
  assert.throws(() => resolveModelDir(null, 'Lora'));
  assert.throws(() => resolveModelDir(root, '  '));
  assert.equal(relToRoot(root, path.join(root, 'Lora', 'Pony')), path.join('Lora', 'Pony'));
  assert.equal(relToRoot(root, 'D:\\other'), 'D:\\other');
});

test('候補は種類のフォルダと直下のサブフォルダ。付属フォルダは出さない', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-models-'));
  try {
    fs.mkdirSync(path.join(root, 'StableDiffusion', 'anime', 'Stable Diffusion_files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'StableDiffusion', 'semi-real'), { recursive: true });
    fs.mkdirSync(path.join(root, 'Lora'), { recursive: true });
    fs.writeFileSync(path.join(root, 'StableDiffusion', 'anime', 'a_v1.safetensors'), 'x');

    assert.deepEqual(listCandidates(root, 'Checkpoint'), [
      'StableDiffusion', path.join('StableDiffusion', 'anime'), path.join('StableDiffusion', 'semi-real'),
    ]);
    // 種類が分からなければ根の直下
    assert.deepEqual(listCandidates(root, 'Workflows'), ['Lora', 'StableDiffusion']);

    assert.deepEqual(findExisting(root, 'Checkpoint', ['A_V1.safetensors', 'b.safetensors']), {
      'A_V1.safetensors': [path.join('StableDiffusion', 'anime', 'a_v1.safetensors')],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('civitai.red も CivitAI として扱う', () => {
  assert.ok(isCivitaiUrl(new URL('https://civitai.red/models/1717562/x?modelVersionId=3353299')));
  assert.ok(isCivitaiUrl(new URL('https://civitai.com/models/1')));
  assert.ok(!isCivitaiUrl(new URL('https://notcivitai.red/models/1')));
  assert.equal(
    thumbUrl('https://image.civitai.com/k/uuid/original=true/1.jpeg'),
    'https://image.civitai.com/k/uuid/width=320/1.jpeg',
  );
});
