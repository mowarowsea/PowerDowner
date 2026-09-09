import type { ResolvedDownload } from '../types.js';

/**
 * CivitAI の各種 URL を、aria2 にそのまま渡せる直リンクに変換する。
 *
 * 対応 URL:
 *   https://civitai.com/models/12345?modelVersionId=67890
 *   https://civitai.com/models/12345                (最新バージョンを選ぶ)
 *   https://civitai.com/api/download/models/67890  (そのまま、トークンだけ付与)
 *
 * トークンはクエリ文字列で付ける。S3 へリダイレクトされる際に Authorization ヘッダが
 * 落ちるため、ヘッダ方式だと認証必須モデルで失敗する。
 */

const API = 'https://civitai.com/api/v1';

interface CivitFile {
  id: number;
  name: string;
  primary?: boolean;
  sizeKB?: number;
  downloadUrl: string;
  hashes?: Record<string, string>;
  type?: string;
}

interface CivitVersion {
  id: number;
  name: string;
  modelId: number;
  files: CivitFile[];
  downloadUrl?: string;
}

export function isCivitaiUrl(u: URL): boolean {
  return /(^|\.)civitai\.com$/i.test(u.hostname);
}

async function apiGet<T>(url: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CivitAI API ${res.status}: ${url}`);
  return (await res.json()) as T;
}

function pickFile(v: CivitVersion): CivitFile {
  const primary = v.files.find((f) => f.primary);
  if (primary) return primary;
  const model = v.files.find((f) => (f.type ?? '').toLowerCase() === 'model');
  if (model) return model;
  if (v.files.length === 0) throw new Error('このモデルバージョンにファイルがありません');
  return v.files[0];
}

function withToken(url: string, token: string | null): string {
  if (!token) return url;
  const u = new URL(url);
  u.searchParams.set('token', token);
  return u.toString();
}

export async function resolveCivitai(u: URL, token: string | null): Promise<ResolvedDownload> {
  let versionId: number | null = null;

  const dl = u.pathname.match(/^\/api\/download\/models\/(\d+)/);
  if (dl) versionId = Number(dl[1]);

  const mv = u.searchParams.get('modelVersionId');
  if (!versionId && mv) versionId = Number(mv);

  const model = u.pathname.match(/^\/models\/(\d+)/);
  if (!versionId && model) {
    const m = await apiGet<{ modelVersions: { id: number }[] }>(`${API}/models/${model[1]}`, token);
    if (!m.modelVersions?.length) throw new Error('モデルにバージョンがありません');
    versionId = m.modelVersions[0].id;
  }

  if (!versionId) throw new Error(`CivitAI の URL として解釈できません: ${u.href}`);

  const v = await apiGet<CivitVersion>(`${API}/model-versions/${versionId}`, token);
  const file = pickFile(v);

  // 元 URL が download URL なら type/format 等の指定を尊重する (token だけ付け直す)
  let base = file.downloadUrl;
  if (dl) {
    const copy = new URL(u.href);
    copy.searchParams.delete('token');
    base = copy.toString();
  }

  const sha = file.hashes?.SHA256 ?? file.hashes?.sha256;
  return {
    url: withToken(base, token),
    filename: file.name,
    checksum: sha ? `sha-256=${sha.toLowerCase()}` : undefined,
    bytesTotal: file.sizeKB ? Math.round(file.sizeKB * 1024) : undefined,
  };
}
