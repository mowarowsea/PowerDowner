export type Engine = 'aria2' | 'jd2' | 'browser';

export type JobStatus =
  | 'queued'        // 投入済み、未着手
  | 'resolving'     // URL 解決中 (CivitAI メタデータ取得など)
  | 'downloading'   // エンジンに渡してダウンロード中
  | 'waiting_human' // 人間の操作待ち (JD2 の CAPTCHA など)
  | 'waiting_site'  // サイト側の無料ダウンロード間隔待ち。時間が来たら自動で再開する
  | 'done'
  | 'failed'
  | 'canceled';

export interface User {
  id: number;
  name: string;
  defaultDir: string | null;
  createdAt: string;
}

export interface Job {
  id: string;
  userId: number;
  url: string;
  destDir: string;
  engine: Engine | null;
  status: JobStatus;
  filename: string | null;
  bytesTotal: number;
  bytesDone: number;
  speed: number;
  error: string | null;
  externalId: string | null;
  meta: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type JobPatch = Partial<Omit<Job, 'id' | 'createdAt'>>;

/** Resolver が返す、aria2 にそのまま渡せる形 */
export interface ResolvedDownload {
  url: string;
  headers?: string[];      // "Name: value" 形式
  filename?: string;
  checksum?: string;       // aria2 形式 "sha-256=<hex>"
  bytesTotal?: number;
  options?: Record<string, string>; // aria2 の追加オプション (user-agent, referer, split など)
}

export interface EngineStatus {
  name: Engine;
  available: boolean;
  detail: string;
}

/**
 * 取得済みアイテムの台帳。ジョブとは別に持つ — サイト A で落とした数か月後に
 * サイト B へ同じ巻が出るのが普通に起きるので、ジョブを消しても所持情報は残す必要がある。
 * (docs/ROADMAP.md 2 章「取得済みアイテムの台帳」)
 */
export type ItemStatus =
  | 'have'     // PowerDowner を通さずに入手済み。投入されても落とさない
  | 'done'     // ジョブが完走した
  | 'pending'; // job_id のジョブが進行中または失敗中。ここへの投入は合流させる

/** 別サイトから同じ巻が投入され、ミラーとして合流した記録 */
export interface MergeRecord {
  source: string | null;   // 'dryeyes:<watch uuid>' など
  urls: string[];
  at: string;
}

export interface LibraryItem {
  id: number;
  /** 持ち主。台帳はユーザー単位なので、重なり判定は常にこれで絞ってから行う */
  userId: number;
  seriesKey: string;
  /** 巻数。取れなかった場合は null で、範囲の重なり判定に参加しない */
  volumeFrom: number | null;
  volumeTo: number | null;
  status: ItemStatus;
  title: string | null;
  author: string | null;
  jobId: string | null;
  source: string | null;
  rawText: string | null;
  mergedFrom: MergeRecord[];
  createdAt: string;
  updatedAt: string;
}
