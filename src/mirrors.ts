import { hostMatches } from './router.js';

/**
 * ミラー候補の並べ替え。
 *
 * 同じファイルが複数のアップローダにある時、落としやすいところから試す。
 * 優先度は config.json の mirrors.priority (ホスト名の並び) で、
 * README の「ホスター別の実績」がそのまま初期値になっている。
 */

/** URL のホスト名。読めない URL は空文字 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 別のホストにある候補を選ぶ。
 *
 * 今のアップローダが同時ダウンロード数で詰まっている時に使う。ふさがっているホスト
 * (別のジョブが今まさに使っているところを含む) は飛ばし、空いている中で一番優先度の
 * 高いものを返す。全部ふさがっていれば null — その時は移さずに待つほうがましで、
 * 同じホストへ移し替えても状況は変わらない。
 */
export function pickFreeHostMirror(
  mirrors: string[],
  busyHosts: Iterable<string>,
  priority: string[]
): string | null {
  const busy = new Set([...busyHosts].map((h) => h.toLowerCase()).filter(Boolean));
  for (const url of sortByPriority(mirrors, priority)) {
    const host = hostOf(url);
    if (!host || busy.has(host)) continue;
    return url;
  }
  return null;
}

/** priority の何番目に当たるか。当たらなければ末尾扱い */
function rankOf(url: string, priority: string[]): number {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return priority.length;
  }
  for (let i = 0; i < priority.length; i++) {
    if (hostMatches(hostname, [priority[i]])) return i;
  }
  return priority.length;
}

/**
 * 優先度順に並べ替える。優先度表に無いホストは末尾へ回すが、
 * 同順位のものは元の並びを保つ — DryEyes がページで見つけた順に意味がある場合を壊さない。
 */
export function sortByPriority(urls: string[], priority: string[]): string[] {
  return urls
    .map((url, index) => ({ url, index, rank: rankOf(url, priority) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((x) => x.url);
}
