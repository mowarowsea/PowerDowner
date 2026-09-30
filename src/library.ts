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
  /**
   * 新規に落とす。missing は所持済みを除いた未取得の巻 (範囲判定に参加しない時は null)。
   * shelfFolder は棚に既にあるこの作品のフォルダ名で、リネームがそこへ入れる (naming.ts)
   */
  | { kind: 'new'; parsed: ParsedItem; missing: number[] | null; shelfFolder?: string | null }
  /** 既に持っているので落とさない */
  | { kind: 'skip'; parsed: ParsedItem; reason: string }
  /** 落とし中のジョブと同じもの。ミラー候補として合流させる */
  | { kind: 'merge'; parsed: ParsedItem; jobId: string }
  /** 同じ投入の中の同じもの。index 番目から作られるジョブへ合流させる */
  | { kind: 'mergeBatch'; parsed: ParsedItem; index: number };

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
  /** 所持は判定できないが、棚のフォルダ名だけは聞いておく分 (巻数を読めなかったもの) */
  const folderOnly = new Set<number>();
  const queryOf = (i: number): OwnQuery => {
    const meta = inputs[i].meta ?? {};
    return {
      title: meta.title ?? null,
      author: meta.author ?? null,
      volume: meta.volume ?? null,
      rawText: meta.rawText ?? null,
    };
  };
  /** 同じ投入の中で、先に出た同じものへ寄せる分。i → 寄せ先の index */
  const twinOf = new Map<number, number>();

  for (let i = 0; i < inputs.length; i++) {
    const parsed = parsedAll[i];

    // 巻数を読めなかったものは重なり判定に参加できない。
    // 黙って捨てるより、もう一度落ちる方が被害が小さい。
    if (parsed.volumeFrom === null || parsed.volumeTo === null || !parsed.seriesKey) {
      decisions[i] = { kind: 'new', parsed, missing: null };
      // 置き場所は巻数と関係なく決まるので、作品名が読めていれば棚のフォルダだけ聞く
      if (parsed.seriesKey) {
        folderOnly.add(askAt.length);
        askAt.push(i);
        queries.push(queryOf(i));
      }
      continue;
    }

    // 同じ投入の中の重なりを先に潰す。この時点ではまだ 1 件もジョブになっていないので、
    // 手元の jobs を見る decideFromJobs では気付けない
    const twin = findTwinInBatch(parsedAll, twinOf, i);
    if (twin !== null) {
      twinOf.set(i, twin);
      continue;
    }

    // 手元で決まるものは手元で決める。落とし中のジョブは pinax には見えない
    const local = decideFromJobs(db, userId, parsed);
    if (local) {
      decisions[i] = local;
      continue;
    }

    askAt.push(i);
    queries.push(queryOf(i));
  }

  const answers = await askOwned(pinax, queries);

  for (let k = 0; k < askAt.length; k++) {
    const i = askAt[k];
    const parsed = parsedAll[i];
    const answer = answers[k];
    const shelfFolder = answer ? pickShelfFolder(answer.series, inputs[i].meta?.author ?? null) : null;

    if (folderOnly.has(k)) {
      decisions[i] = { kind: 'new', parsed, missing: null, shelfFolder };
      continue;
    }

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
      : { kind: 'new', parsed, missing: answer?.missing ?? null, shelfFolder };
  }

  // 寄せた分を、寄せ先の決定に合わせて畳む。寄せ先が落ちないと決まったなら
  // (所持済み・既存ジョブへ合流) こちらも同じ扱いにする — 片方だけ新規で落とすと畳んだ意味が無い
  for (const [i, root] of twinOf) {
    const parsed = parsedAll[i];
    const base = decisions[root]!;
    decisions[i] =
      base.kind === 'skip'
        ? { kind: 'skip', parsed, reason: base.reason }
        : base.kind === 'merge'
          ? { kind: 'merge', parsed, jobId: base.jobId }
          : { kind: 'mergeBatch', parsed, index: root };
  }

  return decisions as ItemDecision[];
}

/**
 * 棚の答えから、この投入を入れるフォルダを 1 つ選ぶ。決めきれなければ null
 * (その時は作者・作品名から組み立てる = 今まで通り)。
 *
 * 同じ seriesKey の作品が複数並ぶことがある (`[BETEMIUS] 同人誌` と `[河内和泉] 同人誌`)。
 * 著者が分かっていればフォルダ名の `[著者]` で絞り、それでも 1 つにならなければ選ばない —
 * 別の作者のフォルダへ入れるくらいなら、新しいフォルダを掘る方が直しやすい。
 */
export function pickShelfFolder(
  series: { folder: string }[] | null | undefined,
  author: string | null
): string | null {
  const folders = [...new Set((series ?? []).map((s) => String(s.folder ?? '').trim()).filter(Boolean))];
  if (folders.length === 1) return folders[0];
  const want = loose(author);
  if (folders.length === 0 || !want) return null;
  const byAuthor = folders.filter((f) => loose(f.match(/^\s*[[［]([^\]］]*)[\]］]/)?.[1]) === want);
  return byAuthor.length === 1 ? byAuthor[0] : null;
}

const loose = (s: string | null | undefined): string =>
  String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/**
 * 同じ投入の中で、先に出た同じものを探す。無ければ null。
 *
 * 同じ巻を別ページで見つけると、DryEyes は区切り文字だけ違うファイル名で 2 件送ってくる
 * (`Haipa_Infureshon_v03-05s.rar` と `Haipa Infureshon v03-05s.rar`)。seriesKey は
 * 記号と空白を落としてあるので既に同じキーになっていて、あとはこの投入の中で
 * 突き合わせるだけでいい。
 *
 * 範囲は**完全に同じものだけ**畳む。手元のジョブとの合流 (decideFromJobs) は重なりで
 * 判定するが、同じ投入の中に 1-3 巻と 3-5 巻が並ぶのは分割セットが両方公開されている
 * 時で、重なりで畳むと 4,5 巻が落ちてこない。
 */
function findTwinInBatch(parsedAll: ParsedItem[], twinOf: Map<number, number>, i: number): number | null {
  const me = parsedAll[i];
  for (let j = 0; j < i; j++) {
    // 既に誰かへ寄せたものは飛ばす。3 件以上同じものが来ても寄せ先は先頭の 1 件
    if (twinOf.has(j)) continue;
    const other = parsedAll[j];
    if (other.seriesKey !== me.seriesKey) continue;
    if (other.volumeFrom !== me.volumeFrom || other.volumeTo !== me.volumeTo) continue;
    return j;
  }
  return null;
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

  // 2. 落としている最中のジョブが**同じ範囲**なら、そこへミラーとして合流させる。
  //
  // 重なりだけで合流させてはいけない。合流した URL はそのジョブのミラー (= 同じファイルの
  // 別の置き場) になるので、1-3巻のジョブへ 3-5巻を寄せると 4,5 巻は落ちてこず、
  // 本命が転んだ時には 3-5巻の中身に「第01-03巻」の名前が付く (findTwinInBatch と同じ理由)。
  // 範囲の違うものは棚に聞いて、足りなければ別のジョブとして落とす
  const pending = jobs.find(
    (j) => j.status !== 'done' && j.volumeFrom === from && j.volumeTo === to
  );
  if (pending) return { kind: 'merge', parsed, jobId: pending.id };

  return null;
}
