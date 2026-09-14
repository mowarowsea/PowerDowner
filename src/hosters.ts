import { hostMatches } from './router.js';
import type { Db } from './db.js';
import { log } from './events.js';
import type { Hoster, HosterDef, Job } from './types.js';

/**
 * アップローダ (ホスター) の台帳。
 *
 * **ドメインではなく業者を 1 行にする。** frdl.io / frdl.hk / frdl.by は同じ業者で、
 * ドメインごとに行を分けると実績が 3 分割されるうえ、片方だけ「使用しない」に倒しても
 * もう片方から入ってくる。抜け道を残さないためにグループで持つ。
 *
 * 台帳の正は DB (hosters テーブル)。config.json の mirrors.priority は
 * **初回だけ** 並び順の種として読む (docs/ROADMAP.md 4 章)。
 */

/** 既定のグループ分け。並びがそのまま初期の優先度になる */
export const DEFAULT_HOSTERS: HosterDef[] = [
  { key: 'dailyuploads', label: 'dailyuploads', domains: ['dailyuploads.net'] },
  { key: 'mexa', label: 'mexa.sh', domains: ['mexa.sh', 'mexashare.com'] },
  { key: 'wupfile', label: 'wupfile', domains: ['wupfile.com'] },
  { key: 'uploady', label: 'uploady', domains: ['uploady.io'] },
  { key: 'turbobit', label: 'turbobit', domains: ['turbobit.net', 'turb.cc', 'turb.to'] },
  { key: 'frdl', label: 'frdl', domains: ['frdl.to', 'frdl.io', 'frdl.my', 'frdl.hk', 'frdl.by'] },
  { key: 'rapidgator', label: 'rapidgator', domains: ['rapidgator.net', 'rg.to'] },
  { key: 'katfile', label: 'katfile', domains: ['katfile.com', 'katfile.biz'] },
];

/**
 * 「.co.uk」のように 2 つで 1 つの TLD。ここに無いものは 1 ラベルの TLD として扱う。
 * 完全な公開接尾辞リストは持ち込まない — 外れても増えるのは表の行が 1 つだけで、
 * 人間が見て「使用しない」に倒せる範囲の間違いに収まる。
 */
const MULTI_PART_TLDS = new Set([
  'co.uk', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.au', 'co.nz', 'co.kr',
  'com.cn', 'co.in', 'com.tr', 'com.mx', 'co.za', 'com.tw',
]);

/**
 * 登録可能ドメインの先頭ラベル。'frdl.hk' -> 'frdl'、'e21.urleecher.com' -> 'urleecher'。
 *
 * 業者キーの素になる。別名ドメインを同じ業者に寄せるのが狙いなので、
 * TLD ではなくラベルを見る (frdl.io と frdl.hk が同じ 'frdl' になる)。
 */
export function registrableLabel(hostname: string): string {
  const parts = String(hostname ?? '').toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const lastTwo = parts.slice(-2).join('.');
  const idx = MULTI_PART_TLDS.has(lastTwo) ? parts.length - 3 : parts.length - 2;
  return parts[Math.max(0, idx)] ?? '';
}

/** URL のホスト名。読めない URL は空文字 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * この URL がどの業者のものか。台帳に無ければ null。
 *
 * null は「アップローダではない」ではなく「まだ知らない」。直リンクや CivitAI も
 * ここでは null になるので、呼び出し側は null を素通しとして扱うこと。
 */
export function hosterKeyOf(url: string, hosters: Pick<Hoster, 'key' | 'domains'>[]): string | null {
  const host = hostnameOf(url);
  if (!host) return null;
  for (const h of hosters) {
    if (h.domains.length > 0 && hostMatches(host, h.domains)) return h.key;
  }
  return null;
}

/**
 * 台帳に無い URL から新しい行の種を作る。
 *
 * key が既存行とぶつかった時は、呼び出し側がその行の domains に足す。
 * frdl が明日 frdl.xyz を使い始めても同じ 'frdl' に吸収される、というのが狙い。
 */
export function newHosterFor(url: string): HosterDef | null {
  const host = hostnameOf(url);
  const key = registrableLabel(host);
  if (!key) return null;
  return { key, label: host.replace(/^www\./, ''), domains: [host.replace(/^www\./, '')] };
}

/**
 * 既定のグループ分けを config.json の並び (ドメインの列) で並べ替える。
 * 既定に無いドメインは、そのドメイン単体の業者として後ろに付く。
 */
export function bootstrapDefs(priority: string[]): HosterDef[] {
  const out: HosterDef[] = [];
  const taken = new Set<string>();

  const push = (def: HosterDef): void => {
    if (taken.has(def.key)) return;
    taken.add(def.key);
    out.push(def);
  };

  for (const domain of priority) {
    const known = DEFAULT_HOSTERS.find((d) => hostMatches(domain, d.domains));
    if (known) { push(known); continue; }
    const made = newHosterFor(`https://${domain}/`);
    if (made) push(made);
  }
  // config に載っていない既定の業者も台帳には出す (使用するかは人間が決める)
  for (const def of DEFAULT_HOSTERS) push(def);
  return out;
}

/**
 * ミラーの並べ替えに渡すドメインの列。
 *
 * 優先度順に、その業者の全ドメインを展開する。「使用しない」業者は候補から
 * 除かれている前提なので、ここでは並びだけを見る。
 */
export function priorityDomains(hosters: Pick<Hoster, 'domains' | 'priority'>[]): string[] {
  return [...hosters]
    .sort((a, b) => a.priority - b.priority)
    .flatMap((h) => h.domains);
}

/**
 * 起動時の台帳の用意。
 *
 * 1. config.json の並びを種にして、まだ無い業者の行を作る (既にある行は触らない — 正は DB)
 * 2. 初回だけ、過去のジョブから実績を数え直して入れる
 */
export function bootstrapHosters(db: Db, priority: string[]): void {
  for (const def of bootstrapDefs(priority)) db.ensureHoster(def);

  if (db.getSetting('hosters_backfilled')) return;
  const stats = countFromJobs(db.listJobs({ limit: 100_000 }), db.listHosters());
  for (const [key, s] of stats) db.seedHosterStats(key, s);
  db.setSetting('hosters_backfilled', new Date().toISOString());
  if (stats.size > 0) log(`[hosters] 過去のジョブ ${stats.size} 業者分の実績を台帳に取り込みました`);
}

/**
 * ジョブの履歴から実績を数える。
 *
 * 数えられるのは「どの URL で駄目だったか」が meta.tried に残っている分まで。
 * 直リンクに化けた後の URL (frdl の e21.urleecher.com など) は台帳に無いので落ちる —
 * 取り込みはあくまで概算で、これ以降の実績は Queue が正確に数える。
 */
export function countFromJobs(
  jobs: Job[],
  hosters: Pick<Hoster, 'key' | 'domains'>[],
): Map<string, { ok: number; fail: number; human: number; lastOkAt: string | null }> {
  const out = new Map<string, { ok: number; fail: number; human: number; lastOkAt: string | null }>();
  const at = (url: string) => {
    const key = hosterKeyOf(url, hosters);
    if (!key) return null;
    let cur = out.get(key);
    if (!cur) { cur = { ok: 0, fail: 0, human: 0, lastOkAt: null }; out.set(key, cur); }
    return cur;
  };

  for (const job of jobs) {
    // 見限った候補は meta.tried に残っている。1 件 1 失敗として数える
    const tried = Array.isArray(job.meta.tried) ? (job.meta.tried as { url?: string }[]) : [];
    for (const t of tried) {
      const e = at(String(t?.url ?? ''));
      if (e) e.fail++;
    }

    const e = at(job.url);
    if (!e) continue;
    if (job.status === 'done') {
      e.ok++;
      if (!e.lastOkAt || e.lastOkAt < job.updatedAt) e.lastOkAt = job.updatedAt;
    } else if (job.status === 'failed') {
      e.fail++;
    } else if (job.status === 'waiting_human') {
      e.human++;
    }
  }
  return out;
}

/**
 * URL の一覧を「使用する」業者のものだけに絞る。
 *
 * 台帳に無い URL (直リンク、CivitAI、まだ知らないアップローダ) は残す —
 * 知らないものを黙って捨てると、新ドメインに移った業者ごと落ちてこなくなる。
 */
export function splitByEnabled(
  urls: string[],
  hosters: Pick<Hoster, 'key' | 'domains' | 'enabled' | 'label'>[],
): { usable: string[]; rejected: { url: string; hoster: string }[] } {
  const usable: string[] = [];
  const rejected: { url: string; hoster: string }[] = [];
  for (const url of urls) {
    const key = hosterKeyOf(url, hosters);
    const hoster = key ? hosters.find((h) => h.key === key) : null;
    if (hoster && !hoster.enabled) rejected.push({ url, hoster: hoster.label });
    else usable.push(url);
  }
  return { usable, rejected };
}
