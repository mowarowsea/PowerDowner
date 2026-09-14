import { EventEmitter } from 'node:events';
import type { Job, EngineStatus } from './types.js';

export interface CaptchaNotice {
  engine: 'jd2';
  pending: number;
  hosts: string[];
  /** headless の JD2 = 人間が解ける画面が無い。呼び出し側は人を呼ばずにブラウザ経路へ任せる */
  headless: boolean;
}

/** 「使用しない」アップローダなので登録しなかった、という知らせ */
export interface RejectedNotice {
  /** 業者名 (画面に出す) */
  hosters: string[];
  /** 何の投入だったか。DryEyes からなら作品名が入る */
  label: string | null;
  source: 'ui' | 'items';
}

export interface BusEvents {
  job: [job: Job];
  jobRemoved: [id: string];
  engine: [status: EngineStatus];
  captcha: [notice: CaptchaNotice];
  rejected: [notice: RejectedNotice];
  log: [line: string];
}

export class Bus extends EventEmitter<BusEvents> {}

export const bus = new Bus();

export function log(line: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${line}`);
  bus.emit('log', line);
}
