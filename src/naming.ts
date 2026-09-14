import path from 'node:path';
import { findVolumeIn, type VolumeUnit } from './volume.js';

/**
 * 保存先のフォルダ名とファイル名を、組み立てるのも読み戻すのもここ 1 か所で行う。
 *
 * 命名は 1 つに決めてある (2026-09-10 に確定。docs/ROADMAP.md「保存先のフォルダ構成」):
 *
 *   [{著者}] {作品名}/[{著者}] {作品名} 第{nn}巻.{拡張子}
 *   [{著者}] {作品名}/[{著者}] {作品名} 第{nn}-{nn}巻.{拡張子}
 *
 * **組み立てと読み戻しは必ず対でここに閉じること。** 書いた名前を次の起動で
 * 棚 (pinax) が読み戻せなくなると、手元にあるのに「持っていない」と判断して
 * 二重に落とす。テンプレートを config で自由にしていないのも同じ理由で、
 * 読み戻せない形を人間が書けてしまうため (ROADMAP の template 案はこれで取り下げ)。
 */

/** 書庫・電子書籍としてありうる拡張子 */
export const CONTENT_EXT = /\.(rar|zip|7z|cbz|cbr|pdf|epub|mobi|azw3?)$/i;
/** 分割書庫のうち、拡張子の手前に入る連番。xxx.part1.rar */
const PART_SUFFIX = /\.part\d+$/i;
/** 分割書庫のうち、拡張子そのものが連番のもの。xxx.r00 / xxx.001 */
export const SPLIT_EXT = /\.(r\d{2}|\d{3})$/i;
/** 同名回避で付けた連番。読み戻す時は落とす */
const SEQ_SUFFIX = /\s*\((\d{1,3})\)$/;

/** Windows がファイル名に使えない文字。消さずに全角へ倒す (作品名の情報を残すため) */
const FORBIDDEN: Record<string, string> = {
  '\\': '＼', '/': '／', ':': '：', '*': '＊',
  '?': '？', '"': '”', '<': '＜', '>': '＞', '|': '｜',
};
/** 拡張子を付けても掴めなくなる予約名。CON.rar は作れない */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** 1 つのフォルダ名 / ファイル名の上限。NTFS は 255 だが、パス全体の余裕を残す */
const SEGMENT_MAX = 110;
/**
 * フルパスの上限。Windows の MAX_PATH は 260 だが、分割書庫の連番や
 * 同名回避の ` (2)` が後から伸びるぶんを引いてある。
 */
const PATH_MAX = 240;

export interface SplitName {
  /** 拡張子・分割連番・同名回避の連番を落とした本体 */
  stem: string;
  /** 拡張子の手前に戻す分割連番 ('.part1')。無ければ空 */
  part: string;
  /** 元の拡張子 ('.rar')。無ければ空 */
  ext: string;
}

/**
 * ファイル名を「本体 / 分割連番 / 拡張子」に割る。
 *
 * 分割書庫の連番を本体から外して**そのまま戻す**のが肝。`xxx.part2.rar` を
 * `第01巻.rar` に均してしまうと part1 と同じ名前になって片方が消え、
 * `.r00` 系はベース名が `.rar` と揃わなくなって解凍できない。
 */
export function splitFilename(name: string): SplitName {
  let s = String(name ?? '');
  let ext = '';
  let part = '';

  const content = s.match(CONTENT_EXT);
  const split = s.match(SPLIT_EXT);
  if (content) {
    ext = content[0];
    s = s.slice(0, -ext.length);
    const p = s.match(PART_SUFFIX);
    if (p) {
      part = p[0];
      s = s.slice(0, -part.length);
    }
  } else if (split) {
    // .r00 / .001 は拡張子そのものが連番。ここを part に回すと拡張子が消える
    ext = split[0];
    s = s.slice(0, -ext.length);
  }

  s = s.replace(SEQ_SUFFIX, '');
  return { stem: s.trim(), part, ext };
}

export interface ParsedName {
  /** 先頭の [...] から取った著者。無ければ null */
  author: string | null;
  /** 著者と巻数を落とした作品名 */
  title: string;
  volumeFrom: number | null;
  volumeTo: number | null;
  unit: VolumeUnit;
  part: string;
  ext: string;
}

/** 先頭の [著者] を切り出す。全角の［］も同じ扱いにする */
function takeAuthor(s: string): { author: string | null; rest: string } {
  const m = s.match(/^\s*[[［]([^\]］]*)[\]］]\s*/);
  if (!m) return { author: null, rest: s.trim() };
  const author = m[1].trim();
  return { author: author || null, rest: s.slice(m[0].length).trim() };
}

/**
 * `[著者] 作品名 第01巻.rar` を読み戻す。
 *
 * **著者を作品名から外すのがここの仕事。** 外さないと `seriesKeyOf` が著者ごと
 * キーに畳み込み、DryEyes から `title: "作品名"` で来た同じ巻と一生噛み合わない
 * (手元にあるのに落とし直す)。
 */
export function parseFilename(name: string): ParsedName {
  const { stem, part, ext } = splitFilename(name);
  const { author, rest } = takeAuthor(stem);
  const { normalized, match } = findVolumeIn(rest);
  const head = (match ? normalized.slice(0, match.start) : normalized).trim();
  return {
    author,
    // 巻数の手前が空なら、巻数表現しか書かれていない。作品名の代わりに全体を残す
    title: head || normalized.trim(),
    volumeFrom: match?.from ?? null,
    volumeTo: match?.to ?? null,
    unit: match?.unit ?? '巻',
    part,
    ext,
  };
}

/** ファイル名として安全な 1 セグメントにする。中身が全部消えたら null */
export function sanitizeSegment(raw: string, max = SEGMENT_MAX): string | null {
  let s = String(raw ?? '').normalize('NFKC');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\\/:*?"<>|]/g, (c) => FORBIDDEN[c] ?? '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = s.slice(0, max).trim();
  // 末尾のピリオドと空白は Windows が黙って落とす。付けたまま作ると、
  // 作ったつもりの名前と実際の名前がずれて探せなくなる
  s = s.replace(/[.\s]+$/, '');
  if (!s) return null;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** 第01巻 / 第01-06巻。3 桁以上はそのまま伸ばす (こち亀 200 巻) */
export function formatVolume(from: number, to: number, unit: VolumeUnit = '巻'): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return from === to ? `第${pad(from)}${unit}` : `第${pad(from)}-${pad(to)}${unit}`;
}

/** `[著者] 作品名`。著者が無ければ作品名だけ (`[] 作品名` にはしない) */
export function seriesLabel(author: string | null | undefined, title: string): string {
  const a = (author ?? '').trim();
  return a ? `[${a}] ${title}` : title;
}

export interface NameInput {
  /** 台帳・投入メタから来た値。空なら元のファイル名から読んだものを使う */
  author?: string | null;
  title?: string | null;
  volumeFrom?: number | null;
  volumeTo?: number | null;
  unit?: VolumeUnit;
}

export interface NamePlan {
  /** 掘る作品フォルダ名。作品名が無ければ null (掘らない) */
  folder: string | null;
  /** 同名回避の連番を付ける前のファイル名 */
  file: string;
  /** 元の名前のままでよい (巻数か作品名が読めなかった) */
  keepName: boolean;
}

/**
 * 落ちてきたファイル 1 つを、どこへどの名前で置くか決める。
 *
 * 足りない値は**元のファイル名から補う** — アップローダのファイル名は既に
 * `[著者] 作品名 第03巻.rar` の形をしていることが多く、DryEyes を通さず手で貼った
 * 時はそれしか手掛かりが無い。
 *
 * 巻数がどうしても読めない時はファイル名を変えない。読めないまま `第01巻` と
 * 決め打ちすると、台帳と手元が食い違って後から直しようがなくなる。
 */
export function planName(filename: string, input: NameInput = {}, opts: { folder?: boolean } = {}): NamePlan {
  const parsed = parseFilename(filename);
  const author = (input.author ?? '').trim() || parsed.author;
  const rawTitle = (input.title ?? '').trim() || parsed.title;
  const volFrom = input.volumeFrom ?? parsed.volumeFrom;
  const volTo = input.volumeTo ?? parsed.volumeTo;
  const unit = input.unit ?? parsed.unit;

  const title = sanitizeSegment(rawTitle);
  const safeAuthor = author ? sanitizeSegment(author) : null;

  // 作品名として信用できるのは、台帳や投入メタから来たか、ファイル名が [著者] か
  // 巻数で区切られていた場合だけ。区切りの無い名前はダウンロード名がまるごと
  // 入っているだけなので、それでフォルダを掘ると rsdjf1me5yac のような
  // フォルダが保存先に増えていく
  const trusted = !!(input.title ?? '').trim() || parsed.author !== null || parsed.volumeFrom !== null;

  // 作品名が無ければ手の出しようがない。掘りも変えもせず、そのまま置く
  if (!title || !trusted) return { folder: null, file: filename, keepName: true };

  const label = seriesLabel(safeAuthor, title);
  const folder = opts.folder === false ? null : sanitizeSegment(label);

  // 巻数が読めないものは名前を変えない。作品フォルダには入れる
  if (volFrom === null || volTo === null) {
    return { folder, file: filename, keepName: true };
  }

  const file = `${label} ${formatVolume(volFrom, volTo, unit)}${parsed.part}${parsed.ext}`;
  return { folder, file, keepName: false };
}

/**
 * パスが長すぎるなら作品名を削って収める。
 *
 * NAS (UNC) の下に `[著者] 作品名` を 2 回重ねると、日本語の長い作品名で
 * あっさり MAX_PATH に届く。届いた時に失敗させるのではなく、名前を詰めてでも置く。
 * それでも収まらなければ作品フォルダを諦める (パスが 1 段浅くなる)。
 */
export function fitPath(baseDir: string, plan: NamePlan, input: NameInput = {}): NamePlan {
  const lengthOf = (p: NamePlan): number => path.join(baseDir, p.folder ?? '', p.file).length;
  if (lengthOf(plan) <= PATH_MAX) return plan;
  // 元の名前を保つと決めたものは削らない。長さより「読み戻せること」を採る
  if (plan.keepName) {
    return plan.folder !== null && lengthOf({ ...plan, folder: null }) <= PATH_MAX
      ? { ...plan, folder: null }
      : plan;
  }

  const parsed = parseFilename(plan.file);
  const author = (input.author ?? '').trim() || parsed.author;
  let title = (input.title ?? '').trim() || parsed.title;

  let next = plan;
  // 作品名は 6 文字までしか削らない。それ以上は人が読めなくなる
  while (title.length > 6) {
    title = title.slice(0, -4).trim();
    next = planName(plan.file, { ...input, author, title, volumeFrom: parsed.volumeFrom, volumeTo: parsed.volumeTo, unit: parsed.unit },
      { folder: plan.folder !== null });
    if (lengthOf(next) <= PATH_MAX) return next;
  }
  return next.folder !== null ? { ...next, folder: null } : next;
}

/**
 * 同じ名前が既にあるなら末尾に連番を付ける。`... 第01巻 (2).rar`
 *
 * 連番は巻数表現の**後ろ**に付ける。`splitFilename` が読み戻す時に落とすので、
 * 台帳のキーにも巻数にも混ざらない。上書きしないのは、同じ巻でも中身が違う
 * (画質違い・修正版) ことがあるため。どちらを捨てるかは人が決める。
 */
export function uniqueName(dir: string, file: string, exists: (p: string) => boolean): string {
  if (!exists(path.join(dir, file))) return file;
  const { stem, part, ext } = splitFilename(file);
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${part}${ext}`;
    if (!exists(path.join(dir, candidate))) return candidate;
  }
  return `${stem} (${Date.now()})${part}${ext}`;
}
