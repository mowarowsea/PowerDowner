import type { ResolvedDownload } from '../types.js';

/**
 * CivitAI の各種 URL を、aria2 にそのまま渡せる直リンクに変換する。
 *
 * 対応 URL (civitai.com / civitai.red のどちらでも。API の形は同じ):
 *   https://civitai.com/models/12345?modelVersionId=67890
 *   https://civitai.com/models/12345                (最新バージョンを選ぶ)
 *   https://civitai.com/api/download/models/67890  (そのまま、トークンだけ付与)
 *
 * トークンはクエリ文字列で付ける。S3 へリダイレクトされる際に Authorization ヘッダが
 * 落ちるため、ヘッダ方式だと認証必須モデルで失敗する。
 */

interface CivitFile {
  id: number;
  name: string;
  primary?: boolean;
  sizeKB?: number;
  downloadUrl: string;
  hashes?: Record<string, string>;
  type?: string;
  metadata?: { format?: string | null; fp?: string | null; size?: string | null };
}

interface CivitImage {
  url: string;
  type?: string;
  nsfwLevel?: number;
  width?: number;
  height?: number;
}

interface CivitVersion {
  id: number;
  name: string;
  modelId: number;
  baseModel?: string;
  files: CivitFile[];
  images?: CivitImage[];
  downloadUrl?: string;
}

interface CivitModel {
  id: number;
  name: string;
  type: string;
  tags?: string[];
  modelVersions: CivitVersion[];
}

export function isCivitaiUrl(u: URL): boolean {
  return /(^|\.)civitai\.(com|red)$/i.test(u.hostname);
}

/** 貼られた URL と同じドメインの API を叩く。.red のモデルは .red で引く */
function apiBase(u: URL): string {
  return `https://${u.hostname.replace(/^www\./i, '')}/api/v1`;
}

async function apiGet<T>(url: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
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

/**
 * ダウンロード URL の転送先 (b2.civitai.com の署名付き URL) を先に引いておく。
 *
 * **aria2 に転送を追わせると、b2 の前の Cloudflare に 403 で弾かれる** (2026-09-24 に確認。
 * 同じ署名付き URL を aria2 に直接渡すと通る。転送の追い方の何かが嫌われている)。
 * 署名は 1 時間ほどで切れるが、切れて止まっても再試行でここを通り直すので、
 * aria2 は .aria2 の続きから再開する。
 *
 * 転送されなかった時は、ログインが要るモデルなどで理由を返してくるので、それを出して止める。
 */
async function signedUrl(url: string, hasToken: boolean): Promise<string> {
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  try { await res.body?.cancel(); } catch { /* ignore */ }
  const location = res.headers.get('location');
  if (res.status >= 300 && res.status < 400 && location) return new URL(location, url).toString();
  if (res.status === 401 || res.status === 403) {
    throw new Error(hasToken
      ? `CivitAI にダウンロードを断られました (HTTP ${res.status})。API キーが古いか、このモデルは早期アクセス中の可能性があります`
      : `このモデルはログインが必要です (HTTP ${res.status})。「ユーザー / 設定」で CivitAI の API キーを入れてください`);
  }
  if (!res.ok) throw new Error(`CivitAI のダウンロード URL が HTTP ${res.status} を返しました`);
  // 転送せずに中身を返してきた。そのまま aria2 に取りに行かせる
  return url;
}

/** URL が指しているバージョン。モデルページで指定が無ければ null (最新を選ぶのは呼び出し側) */
function versionIdOf(u: URL): number | null {
  const dl = u.pathname.match(/^\/api\/download\/models\/(\d+)/);
  if (dl) return Number(dl[1]);
  const mv = u.searchParams.get('modelVersionId');
  return mv && /^\d+$/.test(mv) ? Number(mv) : null;
}

export interface CivitaiPick {
  versionId: number;
  fileId: number;
}

export async function resolveCivitai(u: URL, token: string | null, pick?: CivitaiPick | null): Promise<ResolvedDownload> {
  const api = apiBase(u);
  const dl = /^\/api\/download\/models\/\d+/.test(u.pathname);
  let versionId = pick?.versionId ?? versionIdOf(u);

  const model = u.pathname.match(/^\/models\/(\d+)/);
  if (!versionId && model) {
    const m = await apiGet<{ modelVersions: { id: number }[] }>(`${api}/models/${model[1]}`, token);
    if (!m.modelVersions?.length) throw new Error('モデルにバージョンがありません');
    versionId = m.modelVersions[0].id;
  }

  if (!versionId) throw new Error(`CivitAI の URL として解釈できません: ${u.href}`);

  const v = await apiGet<CivitVersion>(`${api}/model-versions/${versionId}`, token);
  // カードで選んだファイル。消えていたら黙って別のファイルを落とさずに止める
  const file = pick ? v.files.find((f) => f.id === pick.fileId) : pickFile(v);
  if (!file) throw new Error(`選んだファイルが CivitAI 側にもうありません (fileId ${pick?.fileId})`);

  // 元 URL が download URL なら type/format 等の指定を尊重する (token だけ付け直す)
  let base = file.downloadUrl;
  if (dl && !pick) {
    const copy = new URL(u.href);
    copy.searchParams.delete('token');
    base = copy.toString();
  }

  const sha = file.hashes?.SHA256 ?? file.hashes?.sha256;
  return {
    url: await signedUrl(withToken(base, token), token !== null),
    filename: file.name,
    checksum: sha ? `sha-256=${sha.toLowerCase()}` : undefined,
    bytesTotal: file.sizeKB ? Math.round(file.sizeKB * 1024) : undefined,
  };
}

// ---- 確認カード用の下調べ ----------------------------------------------------

export interface CivitaiFileInfo {
  id: number;
  name: string;
  bytes: number;
  primary: boolean;
  /** 'SafeTensor fp16 pruned' のような補足。同じバージョンに複数ファイルがある時の見分け用 */
  note: string;
}

export interface CivitaiImageInfo {
  /** 保存に使う原寸 */
  url: string;
  /** カードに並べる縮小版 */
  thumb: string;
  nsfwLevel: number;
}

export interface CivitaiVersionInfo {
  id: number;
  name: string;
  baseModel: string;
  files: CivitaiFileInfo[];
  /** 静止画だけ。動画はプレビューにならないので落とす */
  images: CivitaiImageInfo[];
}

export interface CivitaiInfo {
  modelId: number;
  name: string;
  type: string;
  tags: string[];
  /** URL が指していたバージョン。指定が無ければ最新 */
  versionId: number;
  versions: CivitaiVersionInfo[];
  /** カードから投入する時の正規化した URL の元 (civitai.com / .red) */
  host: string;
}

/**
 * 画像 URL の変換指定 (`/original=true/`) を差し替えて縮小版を作る。
 * 形が想定と違えば原寸をそのまま使う (カードが重くなるだけで壊れはしない)。
 */
export function thumbUrl(url: string, width = 320): string {
  return url.replace(/\/original=true\//, `/width=${width}/`);
}

function fileNote(f: CivitFile): string {
  const m = f.metadata ?? {};
  return [f.type && f.type !== 'Model' ? f.type : '', m.format ?? '', m.fp ?? '', m.size ?? '']
    .filter(Boolean)
    .join(' ');
}

export async function inspectCivitai(u: URL, token: string | null): Promise<CivitaiInfo> {
  const api = apiBase(u);
  let modelId: number | null = null;
  const page = u.pathname.match(/^\/models\/(\d+)/);
  if (page) modelId = Number(page[1]);

  let versionId = versionIdOf(u);
  if (!modelId) {
    if (!versionId) throw new Error(`CivitAI の URL として解釈できません: ${u.href}`);
    modelId = (await apiGet<CivitVersion>(`${api}/model-versions/${versionId}`, token)).modelId;
  }

  const m = await apiGet<CivitModel>(`${api}/models/${modelId}`, token);
  if (!m.modelVersions?.length) throw new Error('モデルにバージョンがありません');
  if (!versionId || !m.modelVersions.some((v) => v.id === versionId)) versionId = m.modelVersions[0].id;

  return {
    modelId: m.id,
    name: m.name,
    type: m.type,
    tags: (m.tags ?? []).map((t) => String(t)),
    versionId,
    host: u.hostname.replace(/^www\./i, ''),
    versions: m.modelVersions.map((v) => ({
      id: v.id,
      name: v.name,
      baseModel: v.baseModel ?? '',
      files: v.files.map((f) => ({
        id: f.id,
        name: f.name,
        bytes: f.sizeKB ? Math.round(f.sizeKB * 1024) : 0,
        primary: !!f.primary,
        note: fileNote(f),
      })),
      images: (v.images ?? [])
        .filter((i) => (i.type ?? 'image') === 'image' && i.url)
        .map((i) => ({ url: i.url, thumb: thumbUrl(i.url), nsfwLevel: i.nsfwLevel ?? 0 })),
    })),
  };
}
