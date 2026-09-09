import fs from 'node:fs/promises';
import path from 'node:path';
import { parseItem } from './volume.js';

/**
 * 手元にあるファイルから「もう持っている」を台帳に起こすための解釈。
 *
 * ここが見ているのは **ファイル名だけ** で、どのフォルダを歩くか・階層をどう扱うかは
 * 呼び出し側 (config.json の library.scanDirs) が決める。
 * 保存先のフォルダ構成が未定のうちは、その判断をここに埋め込まないこと。
 */

/** 書庫・電子書籍としてありうる拡張子。これ以外は走査対象から外す */
const CONTENT_EXT = /\.(rar|zip|7z|cbz|cbr|pdf|epub|mobi|azw3?)$/i;
/** 分割書庫の連番。xxx.part1.rar / xxx.r00 / xxx.001 */
const PART_SUFFIX = /\.part\d+$/i;
const SPLIT_EXT = /\.(r\d{2}|\d{3})$/i;

export interface ScanCandidate {
  /** 元のファイル名 (拡張子込み) */
  file: string;
  /** 拡張子と分割連番を落とした、表示用の名前 */
  title: string;
  seriesKey: string;
  volumeFrom: number | null;
  volumeTo: number | null;
}

/** 拡張子と分割書庫の連番を落とす。落とし切れなくても致命的ではない (seriesKey が記号を吸収する) */
export function stripExtension(name: string): string {
  let s = name.replace(CONTENT_EXT, '').replace(SPLIT_EXT, '');
  s = s.replace(PART_SUFFIX, '');
  return s.trim();
}

export function candidateFromFilename(name: string): ScanCandidate {
  const title = stripExtension(name);
  // ファイル名は「[著者] 作品名 第03巻」のような生の文字列なので rawText として読ませる。
  // 単位キーワードを伴う巻数しか拾わないため、解像度や年号を巻数と誤読しない
  const parsed = parseItem({ rawText: title });
  return {
    file: name,
    title,
    seriesKey: parsed.seriesKey,
    volumeFrom: parsed.volumeFrom,
    volumeTo: parsed.volumeTo,
  };
}

/** 台帳に入れる価値があるか。巻数が読めなければ重なり判定に参加できないので入れない */
export function isUsable(c: ScanCandidate): boolean {
  return !!c.seriesKey && c.volumeFrom !== null && c.volumeTo !== null;
}

/**
 * ファイル名の一覧から所持候補を作る。
 * 分割書庫は同じ 1 作品を指すので、同一の (作品, 巻範囲) は 1 件にまとめる。
 */
export function scanFilenames(names: string[]): ScanCandidate[] {
  const byKey = new Map<string, ScanCandidate>();
  const unusable: ScanCandidate[] = [];
  for (const name of names) {
    const c = candidateFromFilename(name);
    if (!isUsable(c)) {
      unusable.push(c);
      continue;
    }
    const key = `${c.seriesKey}#${c.volumeFrom}-${c.volumeTo}`;
    if (!byKey.has(key)) byKey.set(key, c);
  }
  return [...byKey.values(), ...unusable];
}

/**
 * ディレクトリを歩いてファイル名を集める。
 *
 * recursive の既定を false にしてあるのは、**フォルダ構成がまだ決まっていない**ため。
 * 「作品ごとにサブフォルダを掘る」なら再帰と階層名の利用が要るし、フラットに置くなら不要。
 * 決まったら、階層のどこを作品名とみなすかをここで足す (今はファイル名しか見ていない)。
 */
export async function listContentFiles(dir: string, opts: { recursive?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        if (opts.recursive) await walk(path.join(current, e.name));
        continue;
      }
      if (CONTENT_EXT.test(e.name) || SPLIT_EXT.test(e.name)) out.push(e.name);
    }
  };
  await walk(dir);
  return out;
}
