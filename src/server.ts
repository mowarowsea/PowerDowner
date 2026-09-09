import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Config } from './config.js';
import { ROOT } from './config.js';
import type { Db } from './db.js';
import { Favicons } from './favicon.js';
import { HttpError, type Queue } from './queue.js';
import type { Aria2Engine } from './engines/aria2.js';
import type { Jd2Engine } from './engines/jd2.js';
import type { BrowserEngine } from './engines/browser.js';
import { bus, log } from './events.js';
import type { Job, EngineStatus, LibraryItem } from './types.js';
import { parseItem, seriesKeyOf } from './volume.js';
import { isUsable, listContentFiles, scanFilenames } from './inventory.js';
import { decideItem, diagnoseItems, type ItemInput } from './library.js';
import type { CaptchaNotice } from './events.js';

interface Deps {
  cfg: Config;
  db: Db;
  queue: Queue;
  aria2: Aria2Engine;
  jd2: Jd2Engine;
  browser: BrowserEngine;
}

function normalizeDir(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!path.isAbsolute(s)) throw new HttpError(400, 'フォルダは絶対パスで指定してください (例: D:\\Downloads)');
  return s;
}

function mask(t: string | null): string | null {
  if (!t) return null;
  return t.length <= 4 ? '****' : '****' + t.slice(-4);
}

export async function buildServer({ cfg, db, queue, aria2, jd2, browser }: Deps) {
  const app = Fastify({ logger: false });
  const favicons = new Favicons(cfg.dataDir);
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, { root: path.join(ROOT, 'public'), prefix: '/' });

  app.setErrorHandler((raw, req, reply) => {
    const err = raw as { statusCode?: number; message?: string };
    const status = raw instanceof HttpError ? raw.statusCode : (err.statusCode ?? 500);
    const message = err.message ?? String(raw);
    if (status >= 500) log(`[http] ${req.method} ${req.url} -> ${message}`);
    reply.status(status).send({ error: message });
  });

  /**
   * プログラムからの投入 (DryEyes) にだけ鍵をかける。
   * UI からの urls 形式を素通しにしているのは、画面を開ける人と同じ権限しか無いため —
   * 新しく増えた「外から自動で叩ける口」を塞ぐのが目的。
   */
  const requireToken = (req: { headers: { authorization?: string } }): void => {
    const expected = cfg.apiToken.trim();
    if (!expected) {
      log('[http] apiToken が未設定のまま items 投入を受けました。config.json の apiToken を設定してください');
      return;
    }
    const got = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (got !== expected) throw new HttpError(401, 'トークンが違います');
  };

  const state = () => ({
    users: db.listUsers(),
    jobs: db.listJobs({ limit: 300 }),
    engines: [aria2.status(), jd2.status(), browser.status()],
    settings: { civitaiToken: mask(db.getSetting('civitai_token')) },
  });

  app.get('/api/state', async () => state());

  // 死活監視用。LocalLauncher の health_url がここを叩く。状態一覧より軽く、
  // エンジンが揃っていなくても「PowerDowner 自体は生きている」を 200 で返す。
  app.get('/api/health', async () => ({
    ok: true,
    engines: {
      aria2: { available: aria2.available, detail: aria2.detail },
      jd2: { available: jd2.available, detail: jd2.detail, headless: jd2.headless },
      browser: { available: browser.available, detail: browser.detail },
    },
  }));

  // ---- favicon ----------------------------------------------------------
  // ジョブ一覧でどのアップローダかを一目で分かるようにする。取得はサーバー側で行い
  // ディスクに貯めるので、ブラウザから各サイトを直接叩くことはない。
  app.get<{ Querystring: { host?: string } }>('/api/favicon', async (req, reply) => {
    const icon = await favicons.get(req.query.host ?? '');
    reply
      .header('cache-control', icon.real ? 'public, max-age=604800' : 'public, max-age=3600')
      .type(icon.type)
      .send(icon.body);
  });

  // ---- users ------------------------------------------------------------
  // 投入先を選ぶ画面 (DryEyes) 向け。名前と既定フォルダが分かるのでトークンを要求する
  app.get('/api/users', async (req) => {
    requireToken(req);
    return { users: db.listUsers() };
  });

  app.post<{ Body: { name?: string; defaultDir?: string | null } }>('/api/users', async (req, reply) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'ユーザー名は必須です');
    const dir = normalizeDir(req.body?.defaultDir);
    try {
      const u = db.createUser(name, dir);
      reply.status(201);
      return u;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) throw new HttpError(409, '同名のユーザーが既にいます');
      throw e;
    }
  });

  app.put<{ Params: { id: string }; Body: { name?: string; defaultDir?: string | null } }>('/api/users/:id', async (req) => {
    const id = Number(req.params.id);
    const patch: { name?: string; defaultDir?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new HttpError(400, 'ユーザー名は必須です');
      patch.name = name;
    }
    if (req.body?.defaultDir !== undefined) patch.defaultDir = normalizeDir(req.body.defaultDir);
    const u = db.updateUser(id, patch);
    if (!u) throw new HttpError(404, 'ユーザーがありません');
    return u;
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id', async (req) => {
    const id = Number(req.params.id);
    try {
      if (!db.deleteUser(id)) throw new HttpError(404, 'ユーザーがありません');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
    return { ok: true };
  });

  // ---- jobs -------------------------------------------------------------
  app.post<{ Body: { userId?: number; urls?: string[] | string; destDir?: string | null; items?: ItemInput[] } }>('/api/jobs', async (req, reply) => {
    const b = req.body ?? {};
    const userId = Number(b.userId);
    if (!Number.isInteger(userId)) throw new HttpError(400, 'ユーザーを選択してください');
    if (b.destDir) normalizeDir(b.destDir);

    // items 形式 = DryEyes からの投入。1 件が 1 ファイルで、urls はその同一ファイルのミラー。
    // 取得済みならスキップ、未完のジョブがあれば合流するので、ここでは 0 件でもエラーにしない
    // (「全部スキップされた」は正常な結果)。
    if (Array.isArray(b.items)) {
      requireToken(req);
      if (b.items.length === 0) throw new HttpError(400, 'items が空です');
      const r = queue.addItems({ userId, destDir: b.destDir ?? null, items: b.items });
      reply.status(201);
      return r;
    }

    const urls = Array.isArray(b.urls) ? b.urls : String(b.urls ?? '').split(/\r?\n|\s+/);
    const r = queue.add({ userId, urls, destDir: b.destDir ?? null });
    if (r.jobs.length === 0) throw new HttpError(400, '有効な URL がありません (http/https で始まる行だけ受け付けます)');
    reply.status(201);
    return r;
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) => queue.retry(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => queue.cancel(req.params.id));
  app.post<{ Params: { id: string } }>('/api/jobs/:id/resume', async (req) => queue.resume(req.params.id));
  // ブラウザで開いているページの調査用。HTML とスクリーンショットを data/debug に落とし、
  // 遮断した要求の一覧を返す (ページが動かないときの原因は大抵ここに出る)
  app.post<{ Params: { id: string }; Querystring: { shot?: string } }>('/api/jobs/:id/dump', async (req) => {
    const r = await browser.dump(req.params.id, req.query.shot !== '0');
    if (!r) throw new HttpError(400, 'このジョブは今ブラウザで開かれていません');
    return r;
  });

  app.delete<{ Params: { id: string } }>('/api/jobs/:id', async (req) => {
    await queue.remove(req.params.id);
    return { ok: true };
  });

  // ---- library (取得済み台帳) ---------------------------------------------
  // 「もう持っている」を登録しておくと、DryEyes から同じ巻が投入されても落とさない。
  // 監視の属性ではなく作品の属性なので、監視をいくつ登録しても 1 人につき 1 か所で済む。
  //
  // 台帳はユーザー単位なので、読み書きする口は必ずユーザーを受け取る。

  /** 台帳を触る口のユーザー解決。存在しない ID を引き取らない */
  const requireUser = (raw: unknown): number => {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new HttpError(400, 'ユーザーを選択してください');
    if (!db.getUser(id)) throw new HttpError(400, `ユーザーが見つかりません: ${id}`);
    return id;
  };

  /**
   * 台帳の一覧。管理画面がこれ 1 本で描けるよう、行そのものに加えて
   * 「その行が指しているジョブの今」と「放っておくと困る点」を添えて返す。
   */
  app.get<{ Querystring: { series?: string; userId?: string; limit?: string } }>('/api/items', async (req) => {
    const limit = Number(req.query.limit);
    const items = db.listItems({
      seriesKey: req.query.series,
      userId: req.query.userId === undefined ? undefined : requireUser(req.query.userId),
      limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 5000) : undefined,
    });
    return { items: diagnoseItems(items, (id) => db.getJob(id)) };
  });

  /**
   * 台帳 1 行を直す。管理画面からの手直し専用。
   *
   * 作品名を変えたら **series_key も導き直す**。ここを揃えないと、名前だけ直って
   * 別作品のままになり、直したつもりで何も変わらない。
   */
  app.patch<{ Params: { id: string }; Body: { title?: string; author?: string | null; volumes?: string } }>(
    '/api/items/:id',
    async (req) => {
      const id = Number(req.params.id);
      const cur = Number.isInteger(id) ? db.getItem(id) : null;
      if (!cur) throw new HttpError(404, '台帳にありません');
      const b = req.body ?? {};
      const patch: { title?: string; author?: string | null; seriesKey?: string; volumeFrom?: number; volumeTo?: number } = {};

      if (b.title !== undefined) {
        const title = String(b.title).trim();
        if (!title) throw new HttpError(400, '作品名は空にできません');
        const key = seriesKeyOf(title);
        if (!key) throw new HttpError(400, `作品名として使えません: ${title}`);
        patch.title = title;
        patch.seriesKey = key;
      }
      if (b.author !== undefined) patch.author = String(b.author ?? '').trim() || null;
      if (b.volumes !== undefined) {
        const raw = String(b.volumes).trim();
        // 巻数だけを見る。読めないものを黙って通すと、重なり判定から静かに外れる
        const parsed = parseItem({ volume: raw });
        if (parsed.volumeFrom === null || parsed.volumeTo === null) {
          throw new HttpError(400, `巻数として読めません: ${raw} (例: 3 または 1-7)`);
        }
        patch.volumeFrom = parsed.volumeFrom;
        patch.volumeTo = parsed.volumeTo;
      }
      if (Object.keys(patch).length === 0) throw new HttpError(400, '直す項目がありません');

      return { item: db.patchItem(id, patch) };
    }
  );

  /**
   * 同じキーの行をまとめて付け替える。
   * 作品名の分からないまま投入されて、生の文字列からキーが作られた行を救うための口 —
   * 1 行ずつ直すと、直した分から新しいキーへ移ってしまい、かえって散らばる。
   */
  app.post<{ Body: { userId?: number; seriesKey?: string; title?: string; author?: string | null } }>(
    '/api/items/relabel',
    async (req) => {
      const b = req.body ?? {};
      const userId = requireUser(b.userId);
      const seriesKey = String(b.seriesKey ?? '');
      if (!seriesKey) throw new HttpError(400, '直す対象がありません');
      const title = String(b.title ?? '').trim();
      if (!title) throw new HttpError(400, '作品名を入力してください');
      const nextKey = seriesKeyOf(title);
      if (!nextKey) throw new HttpError(400, `作品名として使えません: ${title}`);

      const changed = db.relabelSeries(userId, seriesKey, {
        seriesKey: nextKey,
        title,
        author: String(b.author ?? '').trim() || null,
      });
      if (changed === 0) throw new HttpError(404, '対象の行がありません');
      return { changed, seriesKey: nextKey };
    }
  );

  /** まとめて消す。1 作品ぶんを片付けるのに 1 行ずつ叩かせない */
  app.post<{ Body: { ids?: number[] } }>('/api/items/delete', async (req) => {
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter((n) => Number.isInteger(n));
    if (ids.length === 0) throw new HttpError(400, '消す行がありません');
    return { deleted: db.deleteItems(ids) };
  });

  app.post<{
    Body: {
      userId?: number;
      title?: string; author?: string | null; volumes?: string;
      items?: {
        title?: string; author?: string | null; volumes?: string | number | null;
        /** 投入元が結果を突き合わせるための目印。そのまま返す */
        sourceKey?: string | null;
      }[];
    };
  }>('/api/items', async (req, reply) => {
    const b = req.body ?? {};

    // items 形式 = DryEyes が「これは既に持っている」とまとめて登録してくる形。
    // 1 件ずつ巻数が違うので、title + volumes の単数形では表せない
    if (Array.isArray(b.items)) {
      requireToken(req);
      const userId = requireUser(b.userId);
      // 登録した台帳 ID を投入元へ返す。あとで「やっぱり持っていなかった」と
      // 取り消すには、どの行がどのレコードになったかが分かる必要がある
      const created: (LibraryItem & { sourceKey: string | null })[] = [];
      let skipped = 0;
      for (const entry of b.items) {
        const parsed = parseItem({ title: entry.title ?? null, volume: entry.volumes ?? null });
        // 巻数を読めないものは重なり判定に参加できないので、登録しても意味がない
        if (parsed.volumeFrom === null || parsed.volumeTo === null || !parsed.seriesKey) {
          skipped++;
          continue;
        }
        if (db.findOverlappingItems(userId, parsed.seriesKey, parsed.volumeFrom, parsed.volumeTo).length > 0) {
          skipped++;
          continue;
        }
        created.push({
          ...db.insertItem({
            userId,
            seriesKey: parsed.seriesKey,
            volumeFrom: parsed.volumeFrom,
            volumeTo: parsed.volumeTo,
            status: 'have',
            title: entry.title ?? null,
            author: entry.author ?? null,
          }),
          sourceKey: entry.sourceKey ?? null,
        });
      }
      reply.status(201);
      return { created, skipped };
    }

    const userId = requireUser(b.userId);
    const title = String(b.title ?? '').trim();
    if (!title) throw new HttpError(400, '作品名を入力してください');
    const volumes = String(b.volumes ?? '').trim();
    if (!volumes) throw new HttpError(400, '巻数を入力してください (例: 3 または 1-7)');

    const parsed = parseItem({ title, volume: volumes });
    if (parsed.volumeFrom === null || parsed.volumeTo === null) {
      throw new HttpError(400, `巻数として読めません: ${volumes} (例: 3 または 1-7)`);
    }

    // 範囲は 1 巻ずつに展開する。歯抜け (紙で買った巻、落とせなかった巻) が普通に起きるので、
    // 後から 1 件だけ消せる形にしておく
    const created: LibraryItem[] = [];
    let skipped = 0;
    for (let v = parsed.volumeFrom; v <= parsed.volumeTo; v++) {
      if (db.findOverlappingItems(userId, parsed.seriesKey, v, v).length > 0) { skipped++; continue; }
      created.push(db.insertItem({
        userId, seriesKey: parsed.seriesKey, volumeFrom: v, volumeTo: v,
        status: 'have', title, author: b.author ?? null,
      }));
    }
    reply.status(201);
    return { created, skipped };
  });

  /**
   * 投入せずに「もう持っているか」だけを調べる。
   * DryEyes が候補を見せる前に、取得済みのものへ印を付けるために使う。
   * 台帳の中身が分かるので、投入と同じくトークンを要求する。
   */
  app.post<{ Body: { userId?: number; items?: ItemInput[] } }>('/api/items/check', async (req) => {
    requireToken(req);
    const userId = requireUser(req.body?.userId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw new HttpError(400, 'items が空です');

    return {
      results: items.map((item) => {
        // decideItem は台帳を読むだけで、何も書き換えない
        const decision = decideItem(db, userId, item);
        return {
          sourceKey: item.sourceKey ?? null,
          state: decision.kind,
          reason:
            decision.kind === 'skip' ? decision.reason
            : decision.kind === 'merge' ? 'ダウンロード中のものがあります'
            : null,
          seriesKey: decision.parsed.seriesKey,
          volumeFrom: decision.parsed.volumeFrom,
          volumeTo: decision.parsed.volumeTo,
        };
      }),
    };
  });

  // 所持登録の取り消し。UI からの操作でもあるので、他の画面向けの口と同じく素通しにする
  // (投入と違い、これ自体は台帳の中身を外へ出さない)
  app.delete<{ Params: { id: string } }>('/api/items/:id', async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !db.deleteItem(id)) throw new HttpError(404, '台帳にありません');
    return { ok: true };
  });

  /**
   * 手元のファイルから所持済みを起こす。
   * 既定は候補を返すだけで、commit を立てて初めて台帳に入る —
   * ファイル名のパースは外れることがあるので、目で見てから確定させる。
   */
  app.post<{ Body: { userId?: number; dir?: string; commit?: boolean } }>('/api/items/scan', async (req) => {
    const dirs = cfg.library.scanDirs.map((d) => path.resolve(d));
    if (dirs.length === 0) {
      throw new HttpError(400, 'config.json の library.scanDirs が空です。スキャンするフォルダを登録してください');
    }
    const target = path.resolve(String(req.body?.dir ?? dirs[0]));
    // 任意のパスを読ませないため、設定に載せたフォルダだけを対象にする
    if (!dirs.includes(target)) throw new HttpError(400, `library.scanDirs に無いフォルダです: ${target}`);

    let names: string[];
    try {
      names = await listContentFiles(target, { recursive: cfg.library.scanRecursive });
    } catch (e) {
      throw new HttpError(400, `フォルダを読めません: ${target} (${(e as Error).message})`);
    }
    const candidates = scanFilenames(names);
    // 台帳に入れる段になって初めてユーザーが要る。見るだけなら誰のものでもない
    if (!req.body?.commit) return { dir: target, candidates, committed: false };
    const userId = requireUser(req.body?.userId);

    const created: LibraryItem[] = [];
    let skipped = 0;
    for (const c of candidates) {
      if (!isUsable(c) || db.findOverlappingItems(userId, c.seriesKey, c.volumeFrom!, c.volumeTo!).length > 0) {
        skipped++;
        continue;
      }
      created.push(db.insertItem({
        userId, seriesKey: c.seriesKey, volumeFrom: c.volumeFrom, volumeTo: c.volumeTo,
        status: 'have', title: c.title,
      }));
    }
    return { dir: target, candidates, committed: true, created, skipped };
  });

  // ---- settings ---------------------------------------------------------
  app.put<{ Body: { civitaiToken?: string | null } }>('/api/settings', async (req) => {
    const b = req.body ?? {};
    if ('civitaiToken' in b) db.setSetting('civitai_token', b.civitaiToken ? String(b.civitaiToken).trim() : null);
    return { settings: state().settings };
  });

  // ---- websocket --------------------------------------------------------
  app.get('/ws', { websocket: true }, (socket) => {
    const send = (type: string, payload: Record<string, unknown>) => {
      if (socket.readyState === 1) socket.send(JSON.stringify({ type, ...payload }));
    };
    send('hello', { state: state() });
    const onJob = (job: Job) => send('job', { job });
    const onRemoved = (id: string) => send('jobRemoved', { id });
    const onEngine = (status: EngineStatus) => send('engine', { status });
    const onCaptcha = (notice: CaptchaNotice) => send('captcha', { notice });
    const onLog = (line: string) => send('log', { line });
    bus.on('job', onJob);
    bus.on('jobRemoved', onRemoved);
    bus.on('engine', onEngine);
    bus.on('captcha', onCaptcha);
    bus.on('log', onLog);
    socket.on('close', () => {
      bus.off('job', onJob);
      bus.off('jobRemoved', onRemoved);
      bus.off('engine', onEngine);
      bus.off('captcha', onCaptcha);
      bus.off('log', onLog);
    });
  });

  return app;
}
