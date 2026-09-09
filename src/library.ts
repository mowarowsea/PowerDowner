import type { Db } from './db.js';
import type { LibraryItem } from './types.js';
import { parseItem, type ParsedItem } from './volume.js';

/**
 * 取得済み台帳との突き合わせ。
 *
 * 「もう持っているか」「別サイトから来た同じ巻か」の判断はここ 1 か所だけで行う
 * (docs/ROADMAP.md 2 章。DryEyes 側には持ち込まない)。
 */

/** DryEyes から届く 1 件。urls は同一ファイルのミラー */
export interface ItemInput {
  urls: string[];
  sourceKey?: string | null;
  source?: string | null;
  meta?: {
    title?: string | null;
    author?: string | null;
    volume?: string | number | null;
    rawText?: string | null;
    [k: string]: unknown;
  };
}

export type ItemDecision =
  /** 新規に落とす。missing は所持済みを除いた未取得の巻 (範囲判定に参加しない時は null) */
  | { kind: 'new'; parsed: ParsedItem; missing: number[] | null }
  /** 既に持っているので落とさない */
  | { kind: 'skip'; parsed: ParsedItem; item: LibraryItem; reason: string }
  /** 未完のジョブと同じもの。ミラー候補として合流させる */
  | { kind: 'merge'; parsed: ParsedItem; item: LibraryItem; jobId: string };

/**
 * 所持済みの範囲で target を覆えているか調べ、覆えていない巻を返す。
 *
 * 「1-6 巻を持っている状態で 4-8 巻が来た」は 7,8 が残るので落とす — 未所持の巻が
 * 1 つでも残っているなら落とす、が唯一のルール。4,5,6 は重複するが、
 * ファイルを巻単位で切れない以上こうするしかない。
 */
export function missingVolumes(
  target: { from: number; to: number },
  owned: { from: number; to: number }[]
): number[] {
  const covered = new Set<number>();
  for (const o of owned) {
    for (let v = o.from; v <= o.to; v++) covered.add(v);
  }
  const missing: number[] = [];
  for (let v = target.from; v <= target.to; v++) {
    if (!covered.has(v)) missing.push(v);
  }
  return missing;
}

/**
 * 投入 1 件を台帳と突き合わせて、落とすか・スキップか・合流かを決める。
 * 台帳はユーザー単位なので、見るのは userId の分だけ。
 */
export function decideItem(db: Db, userId: number, input: ItemInput): ItemDecision {
  const meta = input.meta ?? {};
  const parsed = parseItem({
    title: meta.title ?? null,
    volume: meta.volume ?? null,
    rawText: meta.rawText ?? null,
  });

  // 巻数を読めなかったものは重なり判定に参加できない。
  // 黙って捨てるより、もう一度落ちる方が被害が小さい。
  if (parsed.volumeFrom === null || parsed.volumeTo === null || !parsed.seriesKey) {
    return { kind: 'new', parsed, missing: null };
  }

  const from = parsed.volumeFrom;
  const to = parsed.volumeTo;
  const overlapping = db.findOverlappingItems(userId, parsed.seriesKey, from, to);

  // 1. 既に持っている分で覆えているならスキップ
  const owned = overlapping.filter((i) => i.status === 'have' || i.status === 'done');
  const missing = missingVolumes(
    { from, to },
    owned.map((i) => ({ from: i.volumeFrom!, to: i.volumeTo! }))
  );
  if (owned.length > 0 && missing.length === 0) {
    const covering = owned[0];
    const range = covering.volumeFrom === covering.volumeTo
      ? `第${covering.volumeFrom}巻`
      : `第${covering.volumeFrom}-${covering.volumeTo}巻`;
    return {
      kind: 'skip',
      parsed,
      item: covering,
      reason: covering.status === 'have' ? `所持済み (${range})` : `取得済み (${range})`,
    };
  }

  // 2. 未完のジョブがあるなら、そこへミラーとして合流させる
  const pending = overlapping.find((i) => i.status === 'pending' && i.jobId);
  if (pending?.jobId) {
    return { kind: 'merge', parsed, item: pending, jobId: pending.jobId };
  }

  return { kind: 'new', parsed, missing };
}
