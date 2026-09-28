import type { ResolvedDownload } from '../types.js';

/**
 * leechtop.com の配布ページを、aria2 にそのまま渡せる直リンクに変換する。
 *
 * ページ上の「Download」ボタンは href="#" で、70 秒のカウントダウン後のクリックで
 * admin-ajax.php に directDownload を POST し、返ってきた `mes` (pubg-file.si などの
 * 署名付き直リンク) へ飛ぶ作り。ページを JD2 に渡すと広告 JS などを拾って数百 KB の
 * ゴミを落としてしまうので、この手順を自前でなぞる。
 *
 * カウントダウンはブラウザ側の見せかけで、サーバーは待ちを強制していない。
 * 無料枠は「1 時間に 1 回」で、使い切ると `mes` が 'no' になる。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export function isLeechtopUrl(u: URL): boolean {
  return /(^|\.)leechtop\.com$/i.test(u.hostname);
}

export interface LeechtopPage {
  ajaxUrl: string;
  nonce: string;
  p: string;
  mb: string;
}

/** 配布ページの HTML から、directDownload を叩くのに要る値を抜く。配布ページでなければ null */
export function parseLeechtopPage(html: string, pageUrl: URL): LeechtopPage | null {
  const btn = html.match(/<a\b[^>]*\bgo-download-direct\b[^>]*>/i)?.[0];
  if (!btn) return null;
  const p = btn.match(/\bdata-p="([^"]+)"/i)?.[1];
  const mb = btn.match(/\bdata-mb="([^"]*)"/i)?.[1] ?? '';
  const nonce = html.match(/"nonce"\s*:\s*"([^"]+)"/)?.[1];
  if (!p || !nonce) return null;
  const ajax = html.match(/"ajax_url"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\\//g, '/');
  const ajaxUrl = ajax ?? new URL('/wp-admin/admin-ajax.php', pageUrl).href;
  return { ajaxUrl, nonce, p, mb };
}

/** 直リンクの末尾から保存名を取る。Content-Disposition が 'attachment' だけで名前を教えてくれないため */
export function filenameFromUrl(url: string): string | undefined {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/** Set-Cookie 群を、次のリクエストに付ける Cookie ヘッダ 1 本にまとめる */
function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

export async function resolveLeechtop(u: URL): Promise<ResolvedDownload> {
  const page = await fetch(u, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20_000) });
  if (!page.ok) throw new Error(`leechtop のページが開けません (${page.status})`);
  const info = parseLeechtopPage(await page.text(), u);
  if (!info) throw new Error('leechtop のダウンロードボタンが見つかりません (ファイルが消されたかも)');

  const cookie = cookieHeader(page);
  const res = await fetch(info.ajaxUrl, {
    method: 'POST',
    headers: {
      'user-agent': UA,
      referer: u.href,
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({
      action: 'z_do_ajax', _action: 'directDownload', p: info.p, mb: info.mb, nonce: info.nonce,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`leechtop が直リンクを返しません (${res.status})`);
  const body = (await res.json().catch(() => null)) as { mes?: unknown } | null;
  const mes = typeof body?.mes === 'string' ? body.mes : '';
  if (mes === 'no') throw new Error('leechtop の無料枠 (1 時間に 1 回) を使い切っています。時間をおいて再試行してください');
  if (!/^https?:\/\//i.test(mes)) throw new Error(`leechtop の応答が想定外です: ${mes.slice(0, 200)}`);

  // 空白入りのまま返ってくるので URL として整形しておく
  const url = new URL(mes).href;
  return {
    url,
    filename: filenameFromUrl(url),
    // Range を無視して 200 で全体を返すサーバーなので分割しない
    options: { 'user-agent': UA, referer: u.href, split: '1', 'max-connection-per-server': '1' },
  };
}
