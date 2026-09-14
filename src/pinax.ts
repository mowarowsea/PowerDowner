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
