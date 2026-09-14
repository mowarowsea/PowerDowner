import type { Db } from './db.js';
import type { Job } from './types.js';
import { parseItem, type ParsedItem } from './volume.js';
import { askOwned, type OwnQuery, type PinaxConfig } from './pinax.js';
import { log } from './events.js';

/**
 * 投入 1 件を「落とす / もう持っている / 落とし中のジョブへ合流」に振り分ける。
 *
 * 判断はここ 1 か所だけで行う (docs/ROADMAP.md 2 章。DryEyes 側には持ち込まない)。
 * 変わったのは**何に聞くか**で、
 *
 * - 「もう持っているか」  … pinax の棚 (POST /api/own)。PowerDowner は台帳を持たない
 * - 「今落としている最中か」… 手元の jobs。**棚を見ても分からない** (まだファイルが無い)
 *
 * 台帳を捨てた経緯は docs/ROADMAP.md の「2.5 取得済みの判定は pinax に聞く」。
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
  | { kind: 'skip'; parsed: ParsedItem; reason: string }
  /** 落とし中のジョブと同じもの。ミラー候補として合流させる */
  | { kind: 'merge'; parsed: ParsedItem; jobId: string };

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

const rangeLabel = (from: number, to: number): string =>
  from === to ? `第${from}巻` : `第${from}-${to}巻`;

/**
 * 投入をまとめて振り分ける。
 *
 * **1 件ずつではなくまとめて聞く。** pinax への往復は 1 回で 200 件まで通るので、
 * 20 件の投入で 20 回叩く理由が無い。手元の jobs で決まったものは聞かずに済ませる。
 *
 * **必ず inputs と同じ長さ・同じ並びで返す。**
 */
export async function decideItems(
  db: Db,
  pinax: PinaxConfig,
  userId: number,
  inputs: ItemInput[]
): Promise<ItemDecision[]> {
  const decisions: (ItemDecision | null)[] = new Array(inputs.length).fill(null);
  const parsedAll = inputs.map((input) =>
    parseItem({
      title: input.meta?.title ?? null,
      volume: input.meta?.volume ?? null,
      rawText: input.meta?.rawText ?? null,
    })
  );

  const askAt: number[] = [];
  const queries: OwnQuery[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const parsed = parsedAll[i];

    // 巻数を読めなかったものは重なり判定に参加できない。
    // 黙って捨てるより、もう一度落ちる方が被害が小さい。
    if (parsed.volumeFrom === null || parsed.volumeTo === null || !parsed.seriesKey) {
      decisions[i] = { kind: 'new', parsed, missing: null };
      continue;
    }

    // 手元で決まるものは手元で決める。落とし中のジョブは pinax には見えない
    const local = decideFromJobs(db, userId, parsed);
    if (local) {
      decisions[i] = local;
      continue;
    }

    const meta = inputs[i].meta ?? {};
    askAt.push(i);
    queries.push({
      title: meta.title ?? null,
      author: meta.author ?? null,
      volume: meta.volume ?? null,
      rawText: meta.rawText ?? null,
    });
  }

  const answers = await askOwned(pinax, queries);

  for (let k = 0; k < askAt.length; k++) {
    const i = askAt[k];
    const parsed = parsedAll[i];
    const answer = answers[k];

    // 読み方が食い違ったら残す。片方だけ直すと、向こうが「持っている」と言った巻を
    // こちらが「持っていない」と言い、静かに二重取得が始まる (volume.ts は移植元が同じ)
    if (answer && answer.parsed.seriesKey !== parsed.seriesKey) {
      log(
        `[pinax] 読み方が食い違っています: こちら "${parsed.seriesKey}" / 棚 "${answer.parsed.seriesKey}"` +
          ` (${queries[k].rawText ?? queries[k].title ?? ''})`
      );
    }

    decisions[i] = answer?.owned
      ? { kind: 'skip', parsed, reason: answer.reason || `所持済み (${rangeLabel(parsed.volumeFrom!, parsed.volumeTo!)})` }
      : { kind: 'new', parsed, missing: answer?.missing ?? null };
  }

  return decisions as ItemDecision[];
}

/**
 * 手元のジョブだけで決まる分を決める。決まらなければ null (= pinax に聞く)。
 *
 * 落とし終わったジョブも見るのは、**棚に載るまでに間がある**ため。pinax のスキャンは
 * 3 時間おきなので、落とした直後に同じ巻が別サイトから来ると、棚はまだ「持っていない」と答える。
 */
function decideFromJobs(db: Db, userId: number, parsed: ParsedItem): ItemDecision | null {
  const from = parsed.volumeFrom!;
  const to = parsed.volumeTo!;
  const jobs = db.findOverlappingJobs(userId, parsed.seriesKey, from, to);
  if (jobs.length === 0) return null;

  const range = (j: Job): string => rangeLabel(j.volumeFrom!, j.volumeTo!);

  // 1. 落とし終わったジョブで覆えているなら、棚を待たずにスキップ
  const done = jobs.filter((j) => j.status === 'done');
  if (done.length > 0) {
    const missing = missingVolumes({ from, to }, done.map((j) => ({ from: j.volumeFrom!, to: j.volumeTo! })));
    if (missing.length === 0) {
      return { kind: 'skip', parsed, reason: `取得済み (${range(done[0])})` };
    }
  }

  // 2. 落としている最中のジョブがあるなら、そこへミラーとして合流させる
  const pending = jobs.find((j) => j.status !== 'done');
  if (pending) return { kind: 'merge', parsed, jobId: pending.id };

  return null;
}
