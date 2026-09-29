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
  /**
   * 投入時に読んだ「どの作品の何巻か」。**判定のためにここへ焼く。**
   * 別サイトから来た同じ巻の合流と、落とした直後 (まだ棚に載っていない) の
   * 二重取得をこれで止める (src/library.ts)。読めなければ null で、重なりの判定に
   * 参加しない — 台帳と違って、ジョブを消せばその巻はまた落とせる。
   */
  seriesKey: string | null;
  volumeFrom: number | null;
  volumeTo: number | null;
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
  /**
   * false = サーバーが Range を無視する (途中から落とせない)。落としかけが残っていると
   * aria2 は続きを要求して code 8 で止まり、何度再試行しても同じところで転ぶので、
   * 投入前に落としかけを捨てて最初から落とす (`Aria2Engine.add`)。
   */
  resumable?: boolean;
}

export interface EngineStatus {
  name: Engine;
  available: boolean;
  detail: string;
}

/** 別サイトから同じ巻が投入され、ミラーとして合流した記録。jobs.meta.mergedFrom に積む */
export interface MergeRecord {
  source: string | null;   // 'dryeyes:<watch uuid>' など
  urls: string[];
  at: string;
}

/**
 * アップローダ (ホスター) 1 業者分。別名ドメインをまとめて 1 行にする。
 * 実績はここに貯めて、どこから試すか・そもそも使うかの判断材料にする。
 */
export interface Hoster {
  /** 業者キー。'frdl' のような登録可能ドメインの先頭ラベル */
  key: string;
  /** 画面に出す名前 */
  label: string;
  /** この業者のドメイン。frdl.io / frdl.hk のような別名を並べる */
  domains: string[];
  /** false なら投入されてもジョブにしない */
  enabled: boolean;
  /** 小さいほど先に試す */
  priority: number;
  /** 実ファイルが残った回数 */
  okCount: number;
  /** ダウンロードを始められなかった / 途中で駄目だった回数。台帳スキップは含まない */
  failCount: number;
  /** 人間の操作を求めた回数 (ジョブごとに 1 回) */
  humanCount: number;
  lastOkAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 台帳に行を起こすための種 */
export interface HosterDef {
  key: string;
  label: string;
  domains: string[];
}

