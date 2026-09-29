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
import type { Job, EngineStatus } from './types.js';
import { parseItem, seriesKeyOf } from './volume.js';
import { decideItems, type ItemInput } from './library.js';
import { searchSeries } from './pinax.js';
import type { CaptchaNotice, RejectedNotice } from './events.js';
import { inspectCivitai, isCivitaiUrl } from './resolvers/civitai.js';
import { findExisting, guessDir, listCandidates, resolveModelDir } from './models.js';

interface Deps {
  cfg: Config;
  db: Db;
  queue: Queue;
  aria2: Aria2Engine;
  jd2: Jd2Engine;
  browser: BrowserEngine;
}

const HTTP_URL = /^https?:\/\//i;

function normalizeDir(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (!path.isAbsolute(s)) throw new HttpError(400, 'フォルダは絶対パスで指定してください (例: D:\\Downloads)');
  return s;
}

/**
 * URL の末尾から、巻数を読ませるためのファイル名らしき文字列を取り出す。
 * ハッシュだけの URL では巻数を読めないが、それは「読めなかった」でよい
 * (台帳に巻数 null で載り、リネームは落ちてきたファイル名から読み直す)。
 */
function fileNameOf(raw: string): string | null {
  try {
    const last = new URL(raw).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last) || null;
  } catch {
    return null;
  }
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
  // アイコンは node_modules から直接配る (リポジトリにはコピーしない)
  await app.register(fastifyStatic, {
    root: path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free'),
    prefix: '/vendor/fa/', decorateReply: false,
  });

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
    jobs: db.listJobs({ limit: 300 }).map((j) => queue.present(j)),
    engines: [aria2.status(), jd2.status(), browser.status()],
    hosters: db.listHosters(),
    settings: {
      civitaiToken: mask(db.getSetting('civitai_token')),
      civitaiModelsRoot: db.getSetting('civitai_models_root'),
    },
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

  // ---- pinax (蔵書) -------------------------------------------------------
  // 「作品として登録する」の作品名・著者を、棚にある綴りから選ばせる。手で書くと
  // 1 文字違うだけで別フォルダに割れ、所持の判定も外れて二重に落とす。
  // 読み取りだけなので UI の他の口と同じく鍵はかけない。
  app.get<{ Querystring: { q?: string } }>('/api/pinax/series', async (req) => {
    try {
      return { items: await searchSeries(cfg.pinax, String(req.query.q ?? '')) };
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  });

  // ---- hosters (アップローダの台帳) ---------------------------------------
  // 「使用しない」に倒したアップローダは投入されてもジョブにしない。サイトが仕様変更で
  // 通らなくなった時、コードを直さずここを倒すだけで運用を続けられるようにするのが狙い。

  app.get('/api/hosters', async () => ({ hosters: db.listHosters() }));

  app.patch<{ Params: { key: string }; Body: { enabled?: boolean; label?: string } }>(
    '/api/hosters/:key',
    async (req) => {
      const cur = db.getHoster(req.params.key);
      if (!cur) throw new HttpError(404, 'アップローダが見つかりません');
      const patch: { enabled?: boolean; label?: string } = {};
      if (typeof req.body?.enabled === 'boolean') patch.enabled = req.body.enabled;
      if (typeof req.body?.label === 'string' && req.body.label.trim()) patch.label = req.body.label.trim();
      const next = db.patchHoster(cur.key, patch);
      if (patch.enabled !== undefined) {
        log(`[hosters] ${next?.label}: ${patch.enabled ? '使用する' : '使用しない'}`);
      }
      return { hoster: next, hosters: db.listHosters() };
    },
  );

  /** 優先度をひとつ上/下へ。並びは 0,1,2... に振り直して隙間を作らない */
  app.post<{ Params: { key: string }; Body: { dir?: string } }>('/api/hosters/:key/move', async (req) => {
    const order = db.listHosters();
    const i = order.findIndex((h) => h.key === req.params.key);
    if (i < 0) throw new HttpError(404, 'アップローダが見つかりません');
    const j = req.body?.dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= order.length) return { hosters: order };
    [order[i], order[j]] = [order[j], order[i]];
    db.renumberHosters(order.map((h) => h.key));
    return { hosters: db.listHosters() };
  });

  // ---- jobs -------------------------------------------------------------
  app.post<{
    Body: {
      userId?: number;
      urls?: string[] | string;
      destDir?: string | null;
      items?: ItemInput[];
      item?: { title?: string | null; author?: string | null; volume?: string | null };
    };
  }>('/api/jobs', async (req, reply) => {
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
      const r = await queue.addItems({ userId, destDir: b.destDir ?? null, items: b.items });
      reply.status(201);
      return r;
    }

    const urls = Array.isArray(b.urls) ? b.urls : String(b.urls ?? '').split(/\r?\n|\s+/);

    // item 形式 = 画面から作品として登録する投入。DryEyes を通さずに作者・作品名を紐づける。
    // 通る道は items (DryEyes) と同じにする — 台帳・リネーム・ミラーの扱いが 2 通りに割れると、
    // どちらから入れたかで挙動が変わってしまう。
    const title = String(b.item?.title ?? '').trim();
    if (title) {
      const author = String(b.item?.author ?? '').trim() || null;
      const volume = String(b.item?.volume ?? '').trim();
      const clean = urls.map((u) => String(u ?? '').trim()).filter((u) => HTTP_URL.test(u));
      if (clean.length === 0) {
        throw new HttpError(400, '有効な URL がありません (http/https で始まる行だけ受け付けます)');
      }

      // 巻数を書いたなら「その 1 ファイルの落とし先が複数ある」= ミラー。
      // 書かなかったなら 1 行 1 巻として扱い、巻数は URL のファイル名から読む。
      const items: ItemInput[] = volume
        ? [{ urls: clean, source: 'manual', sourceKey: null, meta: { title, author, volume } }]
        : clean.map((u) => ({
            urls: [u],
            source: 'manual',
            sourceKey: null,
            meta: { title, author, volume: null, rawText: fileNameOf(u) },
          }));

      const r = await queue.addItems({ userId, destDir: b.destDir ?? null, items });
      reply.status(r.created.length > 0 ? 201 : 200);
      return r;
    }

    const r = queue.add({ userId, urls, destDir: b.destDir ?? null });
    // 「使用しない」で弾いたのはエラーではない。画面に理由を出したいので 200 で返す —
    // 400 にすると「有効な URL がありません」という的外れな文言になる
    if (r.jobs.length === 0 && r.rejected.length === 0) {
      throw new HttpError(400, '有効な URL がありません (http/https で始まる行だけ受け付けます)');
    }
    reply.status(r.jobs.length > 0 ? 201 : 200);
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

  /** ユーザーを受け取る口の解決。存在しない ID を引き取らない */
  const requireUser = (raw: unknown): number => {
    const id = Number(raw);
    if (!Number.isInteger(id)) throw new HttpError(400, 'ユーザーを選択してください');
    if (!db.getUser(id)) throw new HttpError(400, `ユーザーが見つかりません: ${id}`);
    return id;
  };

  /**
   * 投入せずに「もう持っているか」だけを調べる。
   * DryEyes が候補を見せる前に、取得済みのものへ印を付けるために使う。
   *
   * **答えを持っているのは pinax の棚**で、PowerDowner は取得済みの台帳を持たない
   * (docs/ROADMAP.md 2.5)。口の形を変えていないのは、聞く側から見れば
   * 聞くことも答えも変わらないため。userId が要るのは「落としている最中か」の
   * 判定がユーザーごとのジョブを見るからで、棚そのものはユーザーで分かれていない。
   *
   * 棚の中身が分かるので、投入と同じくトークンを要求する。
   */
  app.post<{ Body: { userId?: number; items?: ItemInput[] } }>('/api/items/check', async (req) => {
    requireToken(req);
    const userId = requireUser(req.body?.userId);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw new HttpError(400, 'items が空です');

    // 投入と同じ判定をそのまま通す。別の道で判定すると、画面に出ている印と
    // 実際に投入した時の結果がずれる。何も書き換えない
    const decisions = await decideItems(db, cfg.pinax, userId, items);
    return {
      results: decisions.map((decision, index) => ({
        sourceKey: items[index].sourceKey ?? null,
        state: decision.kind,
        reason:
          decision.kind === 'skip' ? decision.reason
          : decision.kind === 'merge' ? 'ダウンロード中のものがあります'
          : null,
        seriesKey: decision.parsed.seriesKey,
        volumeFrom: decision.parsed.volumeFrom,
        volumeTo: decision.parsed.volumeTo,
      })),
    };
  });

  // ---- CivitAI (確認カード) ------------------------------------------------
  // 貼られた URL を下調べして、カードに並べる材料 (バージョン・ファイル・画像・保存先の候補) を返す。
  // 投入はカードで人間が決めた後に別の口で受ける

  const civitaiUrl = (raw: unknown): URL => {
    let u: URL;
    try { u = new URL(String(raw ?? '').trim()); } catch { throw new HttpError(400, 'URL として解釈できません'); }
    if (!isCivitaiUrl(u)) throw new HttpError(400, `CivitAI の URL ではありません: ${u.hostname}`);
    return u;
  };

  const inspect = async (u: URL) => {
    try {
      return await inspectCivitai(u, db.getSetting('civitai_token'));
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  };

  app.get<{ Querystring: { url?: string } }>('/api/civitai/inspect', async (req) => {
    const info = await inspect(civitaiUrl(req.query.url));
    const root = db.getSetting('civitai_models_root');
    const candidates = root ? listCandidates(root, info.type) : [];
    const lastUsed = db.getSetting(`civitai_last_dir:${info.type.toLowerCase()}`);
    // 当たりはバージョンごと。同じモデルでも v1 は SDXL、v2 は Pony ということがある
    const suggested = Object.fromEntries(
      info.versions.map((v) => [v.id, guessDir(candidates, { tags: info.tags, baseModel: v.baseModel, lastUsed })]),
    );
    const names = [...new Set(info.versions.flatMap((v) => v.files.map((f) => f.name)))];
    const existing = root ? findExisting(root, info.type, names) : {};
    return { info, root, candidates, suggested, lastUsed, existing };
  });

  app.post<{
    Body: { userId?: number; url?: string; versionId?: number; fileId?: number; imageUrl?: string | null; dir?: string };
  }>('/api/civitai/jobs', async (req, reply) => {
    const b = req.body ?? {};
    const userId = requireUser(b.userId);
    // カードの中身は信じず、もう一度引いて突き合わせる。古いカードから別のファイルを落とさないため
    const info = await inspect(civitaiUrl(b.url));
    const v = info.versions.find((x) => x.id === Number(b.versionId));
    if (!v) throw new HttpError(400, '選んだバージョンが見つかりません');
    const f = v.files.find((x) => x.id === Number(b.fileId));
    if (!f) throw new HttpError(400, '選んだファイルが見つかりません');
    const imageUrl = b.imageUrl ? String(b.imageUrl) : null;
    const image = imageUrl ? v.images.find((i) => i.url === imageUrl) : null;
    if (imageUrl && !image) throw new HttpError(400, '選んだ画像がこのバージョンにありません');

    let dir: string;
    try {
      dir = resolveModelDir(db.getSetting('civitai_models_root'), String(b.dir ?? ''));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }

    const job = queue.addCivitai({
      userId, dir, host: info.host,
      modelId: info.modelId, modelName: info.name, type: info.type,
      versionId: v.id, versionName: v.name, baseModel: v.baseModel,
      fileId: f.id, fileName: f.name, bytes: f.bytes,
      imageUrl: image?.url ?? null, thumb: image?.thumb ?? null,
    });
    reply.status(201);
    return { job };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/preview', async (req) => queue.retryPreview(req.params.id));

  // ---- settings ---------------------------------------------------------
  app.put<{ Body: { civitaiToken?: string | null; civitaiModelsRoot?: string | null } }>('/api/settings', async (req) => {
    const b = req.body ?? {};
    if ('civitaiToken' in b) db.setSetting('civitai_token', b.civitaiToken ? String(b.civitaiToken).trim() : null);
    if ('civitaiModelsRoot' in b) db.setSetting('civitai_models_root', normalizeDir(b.civitaiModelsRoot));
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
    const onRejected = (notice: RejectedNotice) => send('rejected', { notice });
    const onLog = (line: string) => send('log', { line });
    bus.on('job', onJob);
    bus.on('jobRemoved', onRemoved);
    bus.on('engine', onEngine);
    bus.on('captcha', onCaptcha);
    bus.on('rejected', onRejected);
    bus.on('log', onLog);
    socket.on('close', () => {
      bus.off('job', onJob);
      bus.off('jobRemoved', onRemoved);
      bus.off('engine', onEngine);
      bus.off('captcha', onCaptcha);
      bus.off('rejected', onRejected);
      bus.off('log', onLog);
    });
  });

  return app;
}
