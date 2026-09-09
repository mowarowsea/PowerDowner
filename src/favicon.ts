import fs from 'node:fs';
import path from 'node:path';

/**
 * サイトのファビコンを取ってきてディスクに貯める。
 *
 * 外部のファビコン API (Google など) は使わない。どのアップローダを使っているかを
 * 他所に渡さずに済むし、一度取れば手元に残るので次からは通信も要らない。
 * 取れなかったサイトは頭文字のバッジ画像を作って返す。UI 側に「無い場合」を作らないため。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const MAX_BYTES = 512 * 1024;
const OK_TTL = 30 * 24 * 3600_000;  // 取れたものは 30 日
const MISS_TTL = 24 * 3600_000;     // 取れなかったものは 1 日で再挑戦

/** 手元のネットワークを覗きに行かせない (URL はユーザー入力由来なので念のため) */
const PRIVATE_RE = /^(localhost|.*\.local|.*\.internal|\d+\.\d+\.\d+\.\d+|\[.*\])$/;

export interface Icon {
  body: Buffer;
  type: string;
  /** サイトから取れた本物か、生成したバッジか */
  real: boolean;
}

const TYPE_BY_MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/gif', (b) => b.subarray(0, 3).toString('latin1') === 'GIF'],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
  ['image/x-icon', (b) => b.length > 4 && b[0] === 0x00 && b[1] === 0x00 && (b[2] === 0x01 || b[2] === 0x02)],
  ['image/svg+xml', (b) => /^\s*(<\?xml|<svg)/i.test(b.subarray(0, 200).toString('utf8'))],
];

function sniff(body: Buffer, headerType: string | null): string | null {
  for (const [type, test] of TYPE_BY_MAGIC) if (test(body)) return type;
  // マジックが分からなくても Content-Type が画像だと言うなら信じる (BMP など)
  if (headerType && /^image\//i.test(headerType)) return headerType.split(';')[0].trim();
  return null;
}

function badge(host: string): Icon {
  const label = (host.replace(/^www\./, '')[0] ?? '?').toUpperCase();
  let h = 0;
  for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="7" fill="hsl(${h % 360} 52% 45%)"/>`
    + `<text x="16" y="23" text-anchor="middle" font-family="system-ui,sans-serif" font-size="19" font-weight="700" fill="#fff">${label}</text>`
    + `</svg>`;
  return { body: Buffer.from(svg, 'utf8'), type: 'image/svg+xml', real: false };
}

async function get(url: string, accept: string): Promise<Response | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA, accept },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? res : null;
  } catch {
    return null;
  }
}

async function body(res: Response): Promise<Buffer | null> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_BYTES) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > 0 && buf.length <= MAX_BYTES ? buf : null;
}

/** トップページの <link rel="icon"> を拾う。無ければ null */
function iconHref(html: string, pageUrl: string): string | null {
  const links = html.slice(0, 200_000).match(/<link\b[^>]*>/gi) ?? [];
  let best: { href: string; size: number } | null = null;
  for (const tag of links) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1] ?? '';
    if (!/\b(shortcut\s+)?icon\b|\bapple-touch-icon\b/i.test(rel)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)/i.exec(tag)?.[1];
    if (!href) continue;
    // sizes="32x32" があれば 32 以上で一番小さいものを選ぶ (無ければ 0 扱い)
    const size = Number(/\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1] ?? 0);
    const score = size >= 32 ? size : 1000 - size;
    if (!best || score < best.size) best = { href, size: score };
  }
  if (!best) return null;
  try { return new URL(best.href, pageUrl).toString(); } catch { return null; }
}

export class Favicons {
  private dir: string;
  private inflight = new Map<string, Promise<Icon>>();

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'favicons');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async get(raw: string): Promise<Icon> {
    const host = String(raw ?? '').trim().toLowerCase().replace(/:\d+$/, '');
    if (!HOST_RE.test(host) || PRIVATE_RE.test(host)) return badge(host || '?');
    const cached = this.readCache(host);
    if (cached) return cached;
    const running = this.inflight.get(host);
    if (running) return running;
    const p = this.fetchIcon(host)
      .catch(() => badge(host))
      .then((icon) => { this.writeCache(host, icon); return icon; })
      .finally(() => { this.inflight.delete(host); });
    this.inflight.set(host, p);
    return p;
  }

  private file(host: string, ext: string): string {
    return path.join(this.dir, `${host}.${ext}`);
  }

  private readCache(host: string): Icon | null {
    try {
      const meta = JSON.parse(fs.readFileSync(this.file(host, 'json'), 'utf8')) as { type: string; real: boolean; at: number };
      const ttl = meta.real ? OK_TTL : MISS_TTL;
      if (Date.now() - meta.at > ttl) return null;
      return { body: fs.readFileSync(this.file(host, 'img')), type: meta.type, real: meta.real };
    } catch {
      return null;
    }
  }

  private writeCache(host: string, icon: Icon): void {
    try {
      fs.writeFileSync(this.file(host, 'img'), icon.body);
      fs.writeFileSync(this.file(host, 'json'), JSON.stringify({ type: icon.type, real: icon.real, at: Date.now() }));
    } catch { /* キャッシュできなくても表示はできる */ }
  }

  /** /favicon.ico → トップページの <link rel="icon"> の順に試す */
  private async fetchIcon(host: string): Promise<Icon> {
    for (const origin of [`https://${host}`, `http://${host}`]) {
      const direct = await get(`${origin}/favicon.ico`, 'image/*,*/*;q=0.8');
      if (direct) {
        const buf = await body(direct);
        const type = buf && sniff(buf, direct.headers.get('content-type'));
        if (buf && type) return { body: buf, type, real: true };
      }
      const page = await get(`${origin}/`, 'text/html,*/*;q=0.8');
      if (!page) continue;
      const html = await page.text().catch(() => '');
      const href = html ? iconHref(html, page.url) : null;
      if (!href) continue;
      const res = await get(href, 'image/*,*/*;q=0.8');
      if (!res) continue;
      const buf = await body(res);
      const type = buf && sniff(buf, res.headers.get('content-type'));
      if (buf && type) return { body: buf, type, real: true };
    }
    return badge(host);
  }
}
