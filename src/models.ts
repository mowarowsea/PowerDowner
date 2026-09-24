import fs from 'node:fs';
import path from 'node:path';

/**
 * CivitAI のモデルを「種類ごとのフォルダ」へ置くための下調べ。
 *
 * フォルダの分け方は人によって違い、固定の表では追いつかない (アニメ / リアルで
 * 分ける人もいれば、LoRA を中身で分ける人もいる)。なので**実際のサブフォルダを
 * 候補に並べ、タグから当たりを付けるだけ**にする。決めるのは確認カードの人間。
 */

/** CivitAI の種類 → モデルの根の下のフォルダ。Forge / A1111 系の共有フォルダの名前 */
const TYPE_DIRS: Record<string, string> = {
  checkpoint: 'StableDiffusion',
  lora: 'Lora',
  locon: 'Lora',
  dora: 'Lora',
  textualinversion: 'Embeddings',
  vae: 'VAE',
  controlnet: 'ControlNet',
  upscaler: 'ESRGAN',
  hypernetwork: 'Hypernetwork',
};

export function typeDirOf(type: string): string | null {
  return TYPE_DIRS[type.toLowerCase()] ?? null;
}

/**
 * フォルダ名 → そのフォルダに当たるタグ。フォルダ名は正規化 (小文字・記号抜き) して引く。
 * フォルダ名とタグが同じなら表に無くても当たる (`character` フォルダと `character` タグ)。
 */
const FOLDER_WORDS: Record<string, string[]> = {
  anime: ['anime', '2d', 'cartoon', 'manga', 'illustration', 'animestyle'],
  semireal: ['realistic', 'photorealistic', 'semirealistic', 'photography', 'photo', 'real', '3d', '25d'],
  real: ['realistic', 'photorealistic', 'semirealistic', 'photography', 'photo', 'real', '3d', '25d'],
  realistic: ['realistic', 'photorealistic', 'semirealistic', 'photography', 'photo', 'real', '3d', '25d'],
  character: ['character', 'characters', 'animecharacter', 'gamecharacter', 'vtuber'],
  clothes: ['clothing', 'clothes', 'outfit', 'costume', 'dress', 'fashion', 'uniform'],
  location: ['background', 'location', 'scenery', 'building', 'landscape', 'architecture'],
  pose: ['pose', 'poses', 'posing'],
  quality: ['quality', 'detail', 'detailed', 'enhancer', 'slider', 'tool'],
  playtheme: ['concept', 'sex', 'action'],
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface GuessInput {
  tags: string[];
  baseModel: string;
  /** その種類で前回選んだフォルダ (根からの相対) */
  lastUsed: string | null;
}

/**
 * 候補 (根からの相対パス) の中から当たりを 1 つ選ぶ。
 *
 * 1. ベースモデル名のフォルダ (`Lora\Pony`)。ベースで分けたフォルダは、分けた本人が
 *    「中身より先にベースで分ける」と決めたもの
 * 2. タグが一番多く当たるフォルダ
 * 3. 前回選んだフォルダ
 * 4. 候補の先頭 (種類のフォルダそのもの)
 */
export function guessDir(candidates: string[], input: GuessInput): string | null {
  if (candidates.length === 0) return null;
  const leaf = (rel: string) => norm(rel.split(/[\\/]/).pop() ?? '');

  const base = norm(input.baseModel);
  if (base) {
    const hit = candidates.find((c) => {
      const l = leaf(c);
      return l.length >= 3 && (base === l || base.startsWith(l));
    });
    if (hit) return hit;
  }

  const tags = new Set(input.tags.map(norm).filter(Boolean));
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const l = leaf(c);
    const words = new Set([l, ...(FOLDER_WORDS[l] ?? [])]);
    let score = 0;
    for (const w of words) if (tags.has(w)) score++;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  if (best) return best;

  if (input.lastUsed && candidates.includes(input.lastUsed)) return input.lastUsed;
  return candidates[0];
}

/** 子フォルダ名のうち、候補に出さないもの (保存した Web ページの付属フォルダなど) */
const JUNK_DIR = /(_files|\.files)$|^\./i;

function subdirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !JUNK_DIR.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'ja'));
  } catch {
    return [];
  }
}

/**
 * 保存先の候補 (根からの相対)。種類が分かればそのフォルダと直下のサブフォルダ、
 * 分からなければ根の直下を全部。
 */
export function listCandidates(root: string, type: string): string[] {
  const typeDir = typeDirOf(type);
  if (typeDir) return [typeDir, ...subdirs(path.join(root, typeDir)).map((d) => path.join(typeDir, d))];
  return subdirs(root);
}

/**
 * 同じ名前のファイルが既にどこにあるか (根からの相対)。種類のフォルダの下を 3 段まで見る。
 * ハッシュまでは取らない — 6 GB のチェックポイントを毎回読むのは重すぎる。
 */
export function findExisting(root: string, type: string, names: string[]): Record<string, string[]> {
  const want = new Map(names.map((n) => [n.toLowerCase(), n]));
  const found: Record<string, string[]> = {};
  const typeDir = typeDirOf(type);
  const start = typeDir ? path.join(root, typeDir) : root;

  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < 3) walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      const orig = want.get(e.name.toLowerCase());
      if (!orig) continue;
      (found[orig] ??= []).push(path.relative(root, path.join(dir, e.name)));
    }
  };
  walk(start, 1);
  return found;
}

/**
 * カードで選んだフォルダを絶対パスにする。相対なら根からたどる。
 * 根の外へ出る相対パス (`..\..`) は受けない — 打ち間違いで思わぬ所に掘らないため。
 */
export function resolveModelDir(root: string | null, dir: string): string {
  const d = dir.trim();
  if (!d) throw new Error('保存先が空です');
  if (path.isAbsolute(d)) return path.normalize(d);
  if (!root) throw new Error('モデルの根が未設定なので、相対パスの保存先を解決できません');
  const abs = path.resolve(root, d);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`モデルの根の外は指定できません: ${d}`);
  return abs;
}

/** 根の中なら相対パス、外なら絶対パス。「前回のフォルダ」はこの形で覚える */
export function relToRoot(root: string | null, abs: string): string {
  if (!root) return abs;
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : abs;
}

// ---- プレビュー画像 ---------------------------------------------------------

const IMAGE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/**
 * 画像の拡張子。**URL の拡張子は当てにならない** — CivitAI は `.jpeg` の URL で png を返してくる。
 * 中身の Content-Type を正とし、分からなければ URL から読む。
 */
export function imageExtOf(contentType: string | null, url: string): string {
  const ct = (contentType ?? '').split(';')[0].trim().toLowerCase();
  if (IMAGE_EXT[ct]) return IMAGE_EXT[ct];
  const m = url.match(/\.(png|jpe?g|webp|gif)(?:$|[?#])/i);
  if (m) return m[1].toLowerCase().startsWith('jp') ? '.jpg' : `.${m[1].toLowerCase()}`;
  return '.png';
}

/** `xxx.safetensors` → `xxx.png`。Forge はモデルと同じ名前の画像をプレビューとして読む */
export function previewNameFor(modelFile: string, ext: string): string {
  const stem = modelFile.replace(/\.[^.\\/]+$/, '');
  return stem + ext;
}

/**
 * プレビュー画像を落として、モデルの隣に同じ名前で置く。返すのは置いたファイル名。
 * 一時ファイルに書いてから名前を付けるので、途中で切れた画像がプレビューに化けない。
 */
export async function savePreview(imageUrl: string, dir: string, modelFile: string): Promise<string> {
  const res = await fetch(imageUrl, { redirect: 'follow', signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`画像を取得できません (HTTP ${res.status})`);
  const ct = res.headers.get('content-type');
  if (ct && !ct.toLowerCase().startsWith('image/')) throw new Error(`画像ではないものが返りました (${ct})`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length === 0) throw new Error('画像が 0 バイトでした');

  const name = previewNameFor(modelFile, imageExtOf(ct, imageUrl));
  const target = path.join(dir, name);
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, target);
  return name;
}
