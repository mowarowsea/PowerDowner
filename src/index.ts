import { loadConfig } from './config.js';
import { Db } from './db.js';
import { Aria2Engine, type Progress } from './engines/aria2.js';
import { Jd2Engine } from './engines/jd2.js';
import { BrowserEngine } from './engines/browser.js';
import { Router } from './router.js';
import { Queue } from './queue.js';
import { buildServer } from './server.js';
import { bus, log } from './events.js';
import { toast } from './notify.js';
import type { ResolvedDownload } from './types.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = new Db(cfg.dataDir);

  // エンジン → キューのコールバックは後から束ねる (循環参照回避)
  let queue: Queue | null = null;
  const cbs = {
    onProgress: (id: string, p: Progress) => queue?.onProgress(id, p),
    onDone: (id: string, f: string | null) => queue?.onDone(id, f),
    onFailed: (id: string, e: string) => queue?.onFailed(id, e),
    onWaitingHuman: (id: string, w: boolean, d: string) => queue?.onWaitingHuman(id, w, d),
    onLinkIds: (id: string, ids: number[]) => queue?.onLinkIds(id, ids),
    onNeedsBrowser: (id: string, reason: string) => queue?.onNeedsBrowser(id, reason),
    onHostLimited: (id: string, reason: string) => queue?.onHostLimited(id, reason),
    onSiteWait: (id: string, at: number, reason: string) => queue?.onSiteWait(id, at, reason),
    onHandoff: (id: string, r: ResolvedDownload) => queue?.onHandoff(id, r),
  };
  const aria2 = new Aria2Engine(cfg, cbs);
  const jd2 = new Jd2Engine(cfg, cbs);
  const browser = new BrowserEngine(cfg, cbs);
  const router = new Router(cfg, db, () => jd2.available, () => browser.available);
  queue = new Queue(cfg, db, aria2, jd2, browser, router);

  // headless の JD2 には解いてもらう画面が無い。エンジン側が自動でブラウザ経路へ回すので、
  // ここで人を呼ぶと「どこで解けばいいのか分からない通知」になってしまう。
  bus.on('captcha', (n) => {
    if (n.pending === 0 || n.headless) return;
    toast('PowerDowner: JD2 が CAPTCHA を待っています', `${n.hosts.join(', ')} のダウンロードで CAPTCHA が出ています。JD2 のウィンドウで解いてください`, 'captcha');
  });

  await Promise.all([aria2.start(), jd2.start(), browser.start()]);
  await queue.recover();

  const app = await buildServer({ cfg, db, queue, aria2, jd2, browser });
  await app.listen({ port: cfg.port, host: cfg.host });
  log(`PowerDowner 起動: http://localhost:${cfg.port}/`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log('終了処理中...');
    try { await app.close(); } catch { /* ignore */ }
    try { await browser.stop(); } catch { /* ignore */ }
    try { await aria2.stop(); } catch { /* ignore */ }
    try { await jd2.stop(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
