import { log } from './events.js';

/**
 * 蔵書カタログ pinax への問い合わせ。
 *
 * **「もう持っているか」を知っているのは pinax だけ。** PowerDowner は取得済みの台帳を
 * 持たない — 台帳はダウンロードの記録であって棚の姿ではないので、手で NAS に置いたもの、
 * 落とす前から持っていたもの、消したものが映らない。経緯は docs/ROADMAP.md の
 * 「2.5 取得済みの判定は pinax に聞く」に書いてある。
 *
 * **聞けなかった時は「持っていない」に倒す。** 黙って持っていることにすると、その巻は
 * 永久に落ちてこない。もう一度落ちる方が被害が小さい (pinax 側も、巻数を読めない
 * 問い合わせを同じ理由で false に倒している)。同名のファイルは `uniqueName` が
 * `... 第01巻 (2).rar` に逃がすので、落とし直しても手元のものは潰れない。
 */

/** pinax に投げる 1 件。DryEyes から届いた生テキストもそのまま渡してよい */
export interface OwnQuery {
  title?: string | null;
  author?: string | null;
  volume?: string | number | null;
  rawText?: string | null;
}

/** pinax の答え 1 件分。`parsed` は向こうがどう読んだか (食い違った時に追うため) */
export interface OwnAnswer {
  parsed: { seriesKey: string; volumeFrom: number | null; volumeTo: number | null };
  owned: boolean;
  /** 未所持の巻。作品が無い・巻数を読めない時は null */
  missing: number[] | null;
  series: { id: number; label: string; folder: string; completed: boolean }[];
  reason: string;
}

export interface PinaxConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

/** pinax 側も 200 件で切る。それに合わせて分割する */
const MAX_PER_REQUEST = 200;

/**
 * 「この巻もう持ってる?」をまとめて聞く。
 *
 * **必ず queries と同じ長さ・同じ並びで返す。** 聞けなかった件は null で、
 * 呼び出し側はそれを「持っていない」として扱う。ここで例外を投げると、
 * pinax が落ちている間は投入そのものが通らなくなる。
 */
export async function askOwned(cfg: PinaxConfig, queries: OwnQuery[]): Promise<(OwnAnswer | null)[]> {
  const answers: (OwnAnswer | null)[] = new Array(queries.length).fill(null);
  if (queries.length === 0) return answers;

  if (!cfg.baseUrl) {
    log('[pinax] 問い合わせ先が設定されていないので、所持の判定なしで落とします (config.json の pinax.baseUrl)');
    return answers;
  }

  for (let offset = 0; offset < queries.length; offset += MAX_PER_REQUEST) {
    const chunk = queries.slice(offset, offset + MAX_PER_REQUEST);
    try {
      const res = await fetch(`${cfg.baseUrl}/api/own`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify({ items: chunk }),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        log(`[pinax] 所持を聞けませんでした (HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''})。この ${chunk.length} 件は落とします`);
        continue;
      }
      const json = (await res.json()) as { answers?: OwnAnswer[] };
      const got = Array.isArray(json.answers) ? json.answers : [];
      // 数が合わない答えは並びを信用できないので丸ごと捨てる。
      // ずれたまま使うと、別の作品の答えでスキップ判定をしてしまう
      if (got.length !== chunk.length) {
        log(`[pinax] 答えの数が合いません (${chunk.length} 件聞いて ${got.length} 件)。この分は落とします`);
        continue;
      }
      for (let i = 0; i < got.length; i++) answers[offset + i] = got[i];
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError'
        ? `${cfg.timeoutMs}ms 以内に答えませんでした`
        : (e as Error).message;
      log(`[pinax] 所持を聞けませんでした (${msg})。この ${chunk.length} 件は落とします`);
    }
  }
  return answers;
}

/** 作品として登録する時の候補として出す、棚にある作品 1 件 */
export interface ShelfSeries {
  id: number;
  title: string;
  author: string | null;
  /** 手元にある冊数。同名の別作品や、名前だけ似た別シリーズを見分ける手がかり */
  files: number;
  /** 「続きが出ている — 8〜15巻が未所持」など。落とす価値があるかがここで分かる */
  shelf: string | null;
}

/** pinax の /api/series が返す 1 件のうち、こちらで使う分だけ */
interface SeriesRow {
  id: number;
  title: string;
  author: string | null;
  /** 棚の実フォルダ名 `[作者] 作品名`。title / author はこれを表示用に整えたもの */
  folder?: string | null;
  fileCount?: number;
  shelf?: { label?: string | null } | null;
}

/**
 * 作者・作品名を、棚の実フォルダ名の綴りで取り出す (DryEyes の services/pinax.ts と同じ)。
 *
 * pinax の title / author は表示用に全角記号を半角へ寄せてある
 * (`～Dahliya～` が `~Dahliya~` になる)。これをそのまま使うとリネーム先のフォルダ名が
 * 既存の棚と 1 文字ずれて、同じ作品が 2 箇所に割れる。だから本物の綴りはフォルダ名から取る。
 *
 * 末尾の `(完)` は棚で完結の印に付けているもので、作品名ではないので外す。
 * 取り出したものが title / author と (表記揺れを除いて) 一致しないときは
 * フォルダ名の形が想定外ということなので、pinax の値をそのまま使う。
 */
export function shelfSpelling(row: Pick<SeriesRow, 'title' | 'author' | 'folder'>): {
  title: string;
  author: string | null;
} {
  const fallback = { title: row.title, author: row.author ?? null };
  const m = (row.folder ?? '').match(/^\[([^\]]+)\]\s*(.+)$/);
  if (!m) return fallback;

  const author = m[1].trim();
  const title = m[2].replace(/\s*[(（]完[)）]\s*$/, '').trim();
  const loose = (s: string | null | undefined) => (s ?? '').normalize('NFKC').trim();
  if (loose(title) !== loose(row.title) || loose(author) !== loose(row.author)) return fallback;

  return { title, author };
}

/**
 * 作者名・作品名の部分一致で棚を引く。作品名・著者の入力欄の候補に使う。
 *
 * 件数を絞るのは、これが「選ばせる」ための一覧だから。数十件並べると結局読めない。
 * 聞けなかった時は例外にする — 画面側は理由を薄く出すだけで、手入力はそのまま使える。
 */
export async function searchSeries(cfg: PinaxConfig, q: string, limit = 8): Promise<ShelfSeries[]> {
  const query = q.trim();
  if (!query) return [];
  if (!cfg.baseUrl) throw new Error('蔵書 (pinax) の問い合わせ先が未設定です');

  const url = new URL(`${cfg.baseUrl}/api/series`);
  url.search = new URLSearchParams({ q: query, limit: String(limit), sort: 'title' }).toString();
  let res: Response;
  try {
    res = await fetch(url, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (e) {
    throw new Error(`蔵書 (pinax) に接続できません: ${(e as Error).message}`);
  }
  if (!res.ok) throw new Error(`蔵書 (pinax) を引けません (HTTP ${res.status})`);

  const json = (await res.json()) as { items?: SeriesRow[] };
  return (json.items ?? []).map((row) => ({
    id: row.id,
    ...shelfSpelling(row),
    files: row.fileCount ?? 0,
    shelf: row.shelf?.label ?? null,
  }));
}

/** 死活確認。設定画面や起動時の警告に使う */
export async function pinaxHealth(cfg: PinaxConfig): Promise<{ ok: boolean; detail: string }> {
  if (!cfg.baseUrl) return { ok: false, detail: '問い合わせ先が未設定です' };
  try {
    const res = await fetch(`${cfg.baseUrl}/api/health`, { signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const json = (await res.json()) as { counts?: { series?: number; volumes?: number } };
    const c = json.counts ?? {};
    return { ok: true, detail: `${c.series ?? 0} 作品 / ${c.volumes ?? 0} 巻` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
