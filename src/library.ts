import type { Db } from './db.js';
import type { Job, JobStatus, LibraryItem } from './types.js';
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

// ---- 管理画面向けの診断 ---------------------------------------------------

/** 台帳 1 行に添える、管理画面向けの見立て */
export interface ItemDiagnosis {
  /** この行が指しているジョブの今。ジョブを消していれば null */
  job: { id: string; status: JobStatus; filename: string | null; error: string | null } | null;
  /** 人が読んでそのまま手を打てる形の警告。空なら問題なし */
  warnings: string[];
}

export type DiagnosedItem = LibraryItem & ItemDiagnosis;

const JOB_STATUS_JA: Partial<Record<JobStatus, string>> = {
  failed: '失敗', canceled: '中止', done: '完了',
};

/** 作品名に紛れ込んだファイル名を見つけるための拡張子。作品名にこれが入ることはまず無い */
const FILE_EXT = /\.(rar|zip|7z|cbz|cbr|pdf|epub|mobi|azw3?)\b/i;

/**
 * 台帳を一覧して、放っておくと困る行に印を付ける。
 *
 * 台帳は「持っている」と言い切る場所なので、**間違った行は 1 つでもその巻を永久に落とせなくする**。
 * 直せる画面を作る前に、どれが怪しいのかが見えないと直しようがない。
 *
 * ここでは何も書き換えない。消すか直すかは人が決める — 自動で片付けると、
 * 本当に持っている行まで巻き添えで消えて、静かに二重取得が始まる。
 */
export function diagnoseItems(items: LibraryItem[], getJob: (id: string) => Job | null): DiagnosedItem[] {
  return items.map((item) => {
    const job = item.jobId ? getJob(item.jobId) : null;
    const warnings: string[] = [];

    // pending は「今落としている最中」の意味。投入されてもここへ合流させるだけなので、
    // 進んでいないまま残ると、その巻の投入は全部この行に吸い込まれて何も起きなくなる
    if (item.status === 'pending') {
      if (!item.jobId) {
        warnings.push('ダウンロード中の扱いですが、ジョブが結び付いていません。この行がある限り、同じ巻を投入しても何も落ちません');
      } else if (!job) {
        warnings.push('ダウンロード中の扱いですが、ジョブが残っていません。落とし直すにはこの行を消してください');
      } else if (job.status === 'failed' || job.status === 'canceled') {
        warnings.push(`ジョブは${JOB_STATUS_JA[job.status]}で終わっています。落とし直すにはこの行を消してください`);
      }
    }

    if (item.volumeFrom === null || item.volumeTo === null) {
      warnings.push('巻数を読めていないので、重複の判定に参加していません (この行は何も止めません)');
    }

    if (!item.title || !item.title.trim()) {
      warnings.push('作品名が無いため、キーを生の文字列から作っています。別サイトから来た同じ巻と噛み合いません');
    } else if (FILE_EXT.test(item.title)) {
      // ファイル名がそのまま作品名として入っている行。キーが落とすのは巻数だけなので、
      // 拡張子もミラーのホスト名もキーに残り、他所から来た同じ巻と一生噛み合わない
      warnings.push('作品名にファイル名が入っています。作品名だけに直さないと、別サイトから来た同じ巻と噛み合いません');
    }

    const dupes = items.filter(
      (o) =>
        o.id !== item.id &&
        o.userId === item.userId &&
        o.seriesKey === item.seriesKey &&
        o.volumeFrom !== null && o.volumeTo !== null &&
        item.volumeFrom !== null && item.volumeTo !== null &&
        item.volumeFrom <= o.volumeTo && item.volumeTo >= o.volumeFrom
    );
    if (dupes.length > 0) {
      warnings.push(`同じ巻を指す行が他にもあります (id ${dupes.map((d) => d.id).join(', ')})`);
    }

    return {
      ...item,
      job: job ? { id: job.id, status: job.status, filename: job.filename, error: job.error } : null,
      warnings,
    };
  });
}
