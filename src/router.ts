import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Engine, Job, ResolvedDownload } from './types.js';
import { isCivitaiUrl, resolveCivitai } from './resolvers/civitai.js';
import { isLeechtopUrl, resolveLeechtop } from './resolvers/leechtop.js';

export interface Route {
  engine: Engine;
  resolved?: ResolvedDownload; // aria2 の場合のみ
}

export function hostMatches(hostname: string, list: string[]): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '');
  return list.some((d) => h === d || h.endsWith('.' + d));
}

export class Router {
  constructor(
    private cfg: Config,
    private db: Db,
    private jd2Available: () => boolean,
    private browserAvailable: () => boolean,
  ) {}

  async resolve(job: Job): Promise<Route> {
    let u: URL;
    try {
      u = new URL(job.url);
    } catch {
      throw new Error('URL として解釈できません');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('http/https 以外の URL は未対応です');

    // 一度ブラウザ引き継ぎに回したジョブは、再試行・復元後もブラウザへ
    if (job.meta.route === 'browser' && this.browserAvailable()) {
      return { engine: 'browser' };
    }

    if (isCivitaiUrl(u)) {
      const token = this.db.getSetting('civitai_token');
      // 確認カードから来たジョブは、カードで選んだバージョンとファイルを落とす
      const c = job.meta.civitai as { versionId?: number; fileId?: number } | undefined;
      const pick = c && Number.isInteger(c.versionId) && Number.isInteger(c.fileId)
        ? { versionId: c.versionId!, fileId: c.fileId! }
        : null;
      const resolved = await resolveCivitai(u, token, pick);
      return { engine: 'aria2', resolved };
    }

    // ボタンが JS で直リンクを引く作りで、JD2 に渡すと広告の JS などを落としてしまう
    if (isLeechtopUrl(u)) {
      return { engine: 'aria2', resolved: await resolveLeechtop(u) };
    }

    // JD2 が扱えない人間判定 (Cloudflare Turnstile など) を使うと分かっているサイトは最初からブラウザへ
    if (hostMatches(u.hostname, this.cfg.browser.hosts) && this.browserAvailable()) {
      return { engine: 'browser' };
    }

    if (hostMatches(u.hostname, this.cfg.jd2.hosts)) {
      return { engine: 'jd2' };
    }

    // それ以外は直リンク候補。HTML が返るページなら JD2 (プラグイン任せ) に回す。
    const kind = await sniff(u);
    if (kind === 'file') {
      return { engine: 'aria2', resolved: { url: u.href } };
    }
    if (this.jd2Available()) {
      return { engine: 'jd2' };
    }
    if (this.browserAvailable()) {
      return { engine: 'browser' };
    }
    throw new Error('ダウンロードファイルではなく Web ページのようです。JD2 かブラウザ引き継ぎが必要です');
  }
}

/** HEAD (ダメなら Range 付き GET) で、ファイルか HTML ページかを判定する */
async function sniff(u: URL): Promise<'file' | 'page' | 'unknown'> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10_000);
  try {
    let res = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
    if (!res.ok) {
      res = await fetch(u, {
        method: 'GET',
        redirect: 'follow',
        signal: ctl.signal,
        headers: { range: 'bytes=0-0' },
      });
      try { await res.body?.cancel(); } catch { /* ignore */ }
    }
    if (!res.ok) return 'unknown';
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const cd = res.headers.get('content-disposition') ?? '';
    if (/attachment/i.test(cd)) return 'file';
    if (ct.startsWith('text/html') || ct.startsWith('application/xhtml')) return 'page';
    return 'file';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(t);
  }
}
