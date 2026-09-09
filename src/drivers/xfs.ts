import type { Page } from 'playwright-core';

/**
 * XFileSharing 系ホスター (katfile, dailyuploads, uploady, wupfile, frdl, mexa.sh など) の
 * 無料ダウンロード手順を自動で進めるドライバ。
 *
 *   1. op=download1 のフォーム (Free / Slow Download ボタン) を送信
 *   2. op=download2 のフォーム: 待ち時間を待ち、人間判定のトークンが入ったら送信
 *   3. 直リンクを探してクリック (ブラウザの download イベント → aria2 へ引き継ぎ)
 *
 * 人間判定 (Turnstile / reCAPTCHA / hCaptcha) は機械で解かず、トークンが入るまで人間を待つ。
 * 認識できない状態になったら manual を返し、ブラウザエンジン側が手動モードに落とす。
 *
 * 注意: ブラウザ内で動かすコードは「文字列」で渡す。関数を渡すと tsx (esbuild) が
 * keepNames の __name ヘルパーを埋め込み、ブラウザ側で ReferenceError になる。
 */

export interface DriverContext {
  page: Page;
  url: string;
  baseDomain: string;
  setStatus(detail: string): void;
  askHuman(message: string): void;
  humanDone(): void;
  downloadDetected(): boolean;
  log(msg: string): void;
}

export type DriveResult =
  | { kind: 'download-started' }
  | { kind: 'direct'; url: string; filename?: string }
  | { kind: 'wait'; ms: number; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'manual'; reason: string };

export interface Snapshot {
  url: string;
  title: string;
  forms: { op: string; id: string }[];
  fname: string;
  wait: string;
  notFound: boolean;
  countdown: number | null;
  turnstile: boolean;
  turnstileToken: string;
  recaptcha: boolean;
  recaptchaToken: string;
  hcaptcha: boolean;
  hcaptchaToken: string;
  imageCaptcha: boolean;
  codeValue: string;
  anchors: { href: string; text: string }[];
  bodyText: string;
  /** 「無料ダウンロード」に相当する要素を見つけて data-pd-free で印を付けたか */
  freeTrigger: boolean;
  freeTriggerText: string;
  /** その要素が disabled (サイト側のカウントダウン中) か */
  freeTriggerDisabled: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ブラウザ内で評価する式。関数渡しにすると esbuild の __name が入るため文字列にする。 */
const SNAPSHOT_JS = `(() => {
  var q = function (s) { return document.querySelector(s); };
  var val = function (s) { var e = document.querySelector(s); return e && e.value ? String(e.value).trim() : ''; };
  var vis = function (el) {
    if (!el) return false;
    if (el.getClientRects().length === 0) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  var bodyText = (document.body ? document.body.innerText : '') || '';
  var forms = [];
  var fs = document.querySelectorAll('form');
  for (var i = 0; i < fs.length; i++) {
    var op = fs[i].querySelector('input[name="op"]');
    // form.id は <input name="id"> に影が差すので getAttribute で取る
    forms.push({ op: op && op.value ? String(op.value).trim() : '', id: fs[i].getAttribute('id') || '' });
  }

  // ---- 無料ダウンロードの間隔制限 ----
  // 表示言語は英語に固定しているが、Cookie 等で他言語になる場合に備えて日本語も見る。
  // 「1 file per 120 minutes」のようなプラン比較表に反応しないよう、文言は具体的に絞る。
  var DUR = '[0-9]+\\\\s*(?:hours?|minutes?|seconds?|mins?|secs?|h|m|s)';
  var waitPatterns = [
    { re: new RegExp('you have to wait\\\\s+([^.\\\\n<]+?)\\\\s+(?:till|until|before)\\\\s+(?:the\\\\s+)?next download', 'i'), suffix: '' },
    { re: new RegExp('delay between downloads must be not less than\\\\s+(' + DUR + ')', 'i'), suffix: '' },
    { re: new RegExp('(?:you can|you may|please)\\\\s+(?:wait|download|try)[^.\\\\n]{0,40}?(?:in|after|within)\\\\s+(' + DUR + ')', 'i'), suffix: '' },
    { re: new RegExp('wait\\\\s+(' + DUR + '(?:[,\\\\s]+' + DUR + ')*)\\\\s*(?:till|until|before|to download)', 'i'), suffix: '' },
    { re: /待機時間は\\s*([0-9]+)\\s*分/, suffix: ' minutes' },
    { re: /([0-9]+)\\s*分以上(?:必要|待)/, suffix: ' minutes' }
  ];
  var wait = '';
  for (var w = 0; w < waitPatterns.length && !wait; w++) {
    var wm = bodyText.match(waitPatterns[w].re);
    if (wm) wait = wm[1] + waitPatterns[w].suffix;
  }

  var notFound = /file not found|no such file|file was deleted|has been removed|file does not exist|file is unavailable|reason for deletion|ファイルが見つかりません|削除されました/i.test(bodyText);

  // ---- サイト側のカウントダウン (表示中のものだけ) ----
  var countdown = null;
  var cds = document.querySelectorAll('#countdown, #free-timer, .seconds, .k-cd-num, [id*="countdown" i], [id*="timer" i], [class*="countdown" i] span, [class*="countdown" i] div, [class*="timer" i] span, [class*="timer" i] div, .time');
  for (var j = 0; j < cds.length; j++) {
    if (!vis(cds[j])) continue;
    var t = (cds[j].textContent || '').trim();
    if (/^[0-9]{1,3}$/.test(t)) { countdown = Number(t); break; }
  }

  // ---- 「無料ダウンロード」の起点を探して印を付ける ----
  // XFileSharing のフォームが無いサイト (turbobit の Vue UI など) でも 1 歩目を進められるようにする。
  var FREE_RE = /free download|regular download|slow speed download|slow download|download for free|無料ダウンロード|低速ダウンロード|通常ダウンロード/i;
  var BAD_RE = /premium|turbo|high speed|upgrade|buy|subscribe|プレミアム|高速|購入/i;
  var marked = document.querySelectorAll('[data-pd-free]');
  for (var mi = 0; mi < marked.length; mi++) marked[mi].removeAttribute('data-pd-free');
  // id / name が「本物の無料ボタン」を示すものを最優先する。
  // 「Continue with Free Download」のような案内リンクより確実。
  var ID_RE = /free_dwn|method_free|fbtn|freebtn|free_btn|slow_btn|download_free|dlfree/i;
  var freeTrigger = false;
  var freeTriggerText = '';
  var freeTriggerDisabled = false;
  var best = null;
  var bestScore = 0;
  var cands = document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"]');
  for (var ci = 0; ci < cands.length; ci++) {
    var el = cands[ci];
    if (!vis(el)) continue;
    var txt = (el.innerText || el.value || '').trim();
    var hrefAttr = el.getAttribute ? (el.getAttribute('href') || '') : '';
    var idn = (el.getAttribute('id') || '') + ' ' + (el.getAttribute('name') || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    if (BAD_RE.test(txt)) continue;
    var score = 0;
    if (ID_RE.test(idn)) score += 3;
    if (/\\/download\\/free\\//i.test(hrefAttr)) score += 2;
    if (FREE_RE.test(txt)) score += 1;
    if (score === 0) continue;
    if (el.disabled) score -= 0.5; // 押せるものを優先しつつ、カウントダウン中の本命も拾う
    if (score > bestScore) { bestScore = score; best = el; }
  }
  // 見つからなければ download1 フォーム内の送信ボタンを最後の手段にする
  if (!best) {
    for (var fj = 0; fj < fs.length; fj++) {
      var opEl = fs[fj].querySelector('input[name="op"]');
      if (!opEl || opEl.value !== 'download1') continue;
      var btns = fs[fj].querySelectorAll('button, input[type="submit"]');
      for (var bj = 0; bj < btns.length; bj++) {
        if (vis(btns[bj]) && !BAD_RE.test(btns[bj].innerText || btns[bj].value || '')) { best = btns[bj]; break; }
      }
      break;
    }
  }
  if (best) {
    best.setAttribute('data-pd-free', '1');
    freeTrigger = true;
    freeTriggerText = ((best.innerText || best.value || '').trim()).slice(0, 60);
    freeTriggerDisabled = !!best.disabled;
  }

  // ---- 表示中のリンク ----
  var anchors = [];
  var as = document.querySelectorAll('a[href]');
  for (var k = 0; k < as.length && anchors.length < 300; k++) {
    if (!vis(as[k])) continue;
    anchors.push({ href: as[k].href, text: (as[k].innerText || '').trim().slice(0, 60) });
  }

  var hasHcaptcha = !!(q('textarea[name="h-captcha-response"]') || q('.h-captcha')
    || q('script[src*="hcaptcha.com"]') || q('iframe[src*="hcaptcha.com"]'));

  return {
    url: location.href,
    title: document.title,
    forms: forms,
    fname: val('input[name="fname"]'),
    wait: wait,
    notFound: notFound,
    countdown: countdown,
    turnstile: !!(q('input[name="cf-turnstile-response"]') || q('.cf-turnstile') || q('iframe[src*="challenges.cloudflare.com"]')),
    turnstileToken: val('input[name="cf-turnstile-response"]'),
    // hCaptcha は recaptchacompat モードだと g-recaptcha-response も作る。
    // hCaptcha の痕跡があるときは reCAPTCHA 扱いにしない (待つ相手を間違えると表示が嘘になる)
    recaptcha: !hasHcaptcha && !!(q('textarea[name="g-recaptcha-response"]') || q('.g-recaptcha')),
    recaptchaToken: hasHcaptcha ? '' : val('textarea[name="g-recaptcha-response"]'),
    hcaptcha: hasHcaptcha,
    hcaptchaToken: val('textarea[name="h-captcha-response"]') || (hasHcaptcha ? val('textarea[name="g-recaptcha-response"]') : ''),
    imageCaptcha: !!(q('input[name="code"]') || q('input[name="captcha_response"]')),
    codeValue: val('input[name="code"]') || val('input[name="captcha_response"]'),
    anchors: anchors,
    bodyText: bodyText.slice(0, 4000),
    freeTrigger: freeTrigger,
    freeTriggerText: freeTriggerText,
    freeTriggerDisabled: freeTriggerDisabled
  };
})()`;

export async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(SNAPSHOT_JS) as Promise<Snapshot>;
}

/** ドライバが何かしら操作できそうなページか */
export function isXfsLikely(snap: Snapshot): boolean {
  return snap.forms.some((f) => f.op === 'download1' || f.op === 'download2')
    || snap.wait !== '' || snap.notFound || snap.freeTrigger;
}

/** "1 hour, 50 minutes, 17 seconds" / "120 minutes" → ms */
export function parseWait(text: string): number {
  let ms = 0;
  for (const m of text.matchAll(/(\d+)\s*(hours?|minutes?|seconds?|std|min|sec|h|m|s)\b/gi)) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u.startsWith('h') || u === 'std') ms += n * 3600_000;
    else if (u.startsWith('m')) ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms;
}

/** 押す対象はスナップショットが data-pd-free で選んでいるので、それだけを使う */
const FREE_BUTTONS = ['[data-pd-free="1"]'];

const SUBMIT_BUTTONS = [
  'form:has(input[name="op"][value="download2"]) #btn_download',
  'form:has(input[name="op"][value="download2"]) button[type="submit"]',
  'form:has(input[name="op"][value="download2"]) input[type="submit"]',
  'form:has(input[name="op"][value="download2"]) button:not([type="button"])',
  '#btn_download',
];

const FILE_EXT = /\.(rar|zip|7z|tar|gz|mp4|mkv|avi|wmv|mov|mp3|flac|pdf|iso|exe|bin|dat|apk|epub|cbz|cbr|r\d\d|part\d+)(\?|$)/i;

async function clickFirst(page: Page, selectors: string[], log: (m: string) => void): Promise<boolean> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() === 0) continue;
      if (!(await loc.isVisible())) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => { /* ignore */ });
      await loc.click({ timeout: 5000 });
      log(`click ${sel}`);
      return true;
    } catch (e) {
      log(`click ${sel} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  return false;
}

/**
 * ファイルらしい URL を選ぶ。
 *
 * 直リンクは別ドメインで配られることが多い (frdl.hk → e21.urleecher.com) ので、
 * 同一サイト条件では本物を捨ててしまう。代わりに「期待するファイル名と一致するか」
 * 「パスがファイルを指しているか」で判断し、別ドメインには確証を多めに要求する。
 */
function pickDirectLink(snap: Snapshot, baseDomain: string, fname: string): string | null {
  const want = fname ? decodeURIComponent(fname).toLowerCase() : '';
  let best: { href: string; score: number } | null = null;
  for (const a of snap.anchors) {
    let u: URL;
    try { u = new URL(a.href); } catch { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    if (/op=payments|premium|login|register|signup|upgrade|\?op=/i.test(a.href)) continue;
    if (a.href.split('#')[0] === snap.url.split('#')[0]) continue;

    const host = u.hostname.toLowerCase();
    const sameSite = host === baseDomain || host.endsWith('.' + baseDomain);
    const isFilePath = FILE_EXT.test(u.pathname);
    let pathname = u.pathname;
    try { pathname = decodeURIComponent(u.pathname); } catch { /* 壊れたエスケープ */ }

    let score = 0;
    if (want && pathname.toLowerCase().endsWith(want)) score += 4;      // ファイル名そのもの
    else if (want && decodeURIComponent(a.href).toLowerCase().includes(want)) score += 3;
    if (isFilePath) score += 1;
    if (/download/i.test(a.text)) score += 1;
    if (/\/d\/|\/dl\/|\/files\/|\/download\//i.test(u.pathname)) score += 1;

    // 別ドメインを許す代わりに、パスがファイルを指していることを必須にする
    if (!sameSite && !isFilePath) continue;
    if (score >= (sameSite ? 2 : 3) && (!best || score > best.score)) best = { href: a.href, score };
  }
  return best?.href ?? null;
}

async function waitForDownload(ctx: DriverContext, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (ctx.downloadDetected()) return true;
    await sleep(500);
  }
  return ctx.downloadDetected();
}

/**
 * 人間判定の待ち。まず数秒は自動通過 (Turnstile の managed モードなど) を期待して待ち、
 * ダメなら人間を呼ぶ。トークンが入ったら true。
 */
async function waitForChallenge(ctx: DriverContext, kind: 'turnstile' | 'recaptcha' | 'hcaptcha', maxMs: number): Promise<boolean> {
  const label = kind === 'turnstile' ? 'Cloudflare Turnstile' : kind === 'recaptcha' ? 'reCAPTCHA' : 'hCaptcha';
  // hCaptcha は recaptchacompat モードだと g-recaptcha-response 側に入る
  const fields = kind === 'turnstile' ? ['cf-turnstile-response']
    : kind === 'recaptcha' ? ['g-recaptcha-response']
      : ['h-captcha-response', 'g-recaptcha-response'];
  const sel = fields.map((f) => `[name="${f}"]`).join(',');
  // DOM 全体のスナップショットは撮らない。人間がチェックを押している最中にページを重く
  // 触ると、Cloudflare Turnstile が検証に失敗して「Verification failed」になる。
  const tokenJs = `(function(){var l=document.querySelectorAll('${sel}');`
    + `for(var i=0;i<l.length;i++){if(l[i].value)return l[i].value;}return '';})()`;

  const start = Date.now();
  let asked = false;
  while (Date.now() - start < maxMs) {
    if (ctx.downloadDetected()) return true;
    const token = await (ctx.page.evaluate(tokenJs) as Promise<string>).catch(() => '');
    if (token) {
      if (asked) ctx.humanDone();
      ctx.log(`${label} token ok (${asked ? 'human' : 'auto'})`);
      return true;
    }
    if (!asked && Date.now() - start > 8000) {
      asked = true;
      ctx.askHuman(`あなたの番: ブラウザの ${label} のチェックを押してください。押せば続きは自動です`);
    } else if (!asked) {
      ctx.setStatus(`自動操作中: ${label} の自動通過を待っています`);
    }
    // 人間を待っている間は間隔を空ける (触る回数そのものを減らす)
    await sleep(asked ? 2500 : 1000);
  }
  return false;
}

export async function drive(ctx: DriverContext): Promise<DriveResult> {
  const { page } = ctx;
  let step1Tried = 0;
  let submitTried = 0;
  let fname = '';
  let lastUrl = '';
  let unknownStreak = 0;
  let waitStreak = 0;
  const deadline = Date.now() + 15 * 60_000;

  while (Date.now() < deadline) {
    if (ctx.downloadDetected()) return { kind: 'download-started' };
    const snap = await snapshot(page).catch(() => null);
    if (!snap) { await sleep(1000); continue; }
    if (snap.fname) fname = snap.fname;
    // ページが進んだら試行回数をリセットする (多段フローのサイト向け)
    if (snap.url !== lastUrl) {
      if (lastUrl) ctx.log(`page -> ${snap.url.slice(0, 120)}`);
      lastUrl = snap.url;
      step1Tried = 0;
      submitTried = 0;
      unknownStreak = 0;
      waitStreak = 0;
    }

    if (snap.notFound) return { kind: 'failed', reason: 'ファイルが見つかりません (削除済みの可能性)' };
    if (snap.wait) {
      const ms = parseWait(snap.wait);
      if (ms > 0) return { kind: 'wait', ms, reason: `サイトの無料ダウンロード間隔: ${snap.wait.trim()}` };
    }

    const hasDl1 = snap.forms.some((f) => f.op === 'download1');
    const hasDl2 = snap.forms.some((f) => f.op === 'download2');

    // ---- サイトのカウントダウン -----------------------------------------------
    if (snap.countdown !== null && snap.countdown > 0 && !hasDl1) {
      ctx.setStatus(`自動操作中: サイトの待ち時間 ${snap.countdown} 秒`);
      await sleep(1000);
      continue;
    }

    // ---- 人間判定 -------------------------------------------------------------
    // 1 歩目のページ (download1 フォームがある) では、Cloudflare の常時ウィジェットに
    // 反応して無駄に人間を呼ばないよう、判定待ちはしない。
    if (!hasDl1) {
      if (snap.turnstile && !snap.turnstileToken) {
        if (!(await waitForChallenge(ctx, 'turnstile', 10 * 60_000))) return { kind: 'manual', reason: 'Turnstile が通過しませんでした' };
        continue;
      }
      if (snap.recaptcha && !snap.recaptchaToken) {
        if (!(await waitForChallenge(ctx, 'recaptcha', 10 * 60_000))) return { kind: 'manual', reason: 'reCAPTCHA が通過しませんでした' };
        continue;
      }
      if (snap.hcaptcha && !snap.hcaptchaToken) {
        if (!(await waitForChallenge(ctx, 'hcaptcha', 10 * 60_000))) return { kind: 'manual', reason: 'hCaptcha が通過しませんでした' };
        continue;
      }
      if (snap.imageCaptcha && !snap.codeValue) {
        ctx.askHuman('あなたの番: 画像の文字をブラウザの入力欄に入力してください。入力後は自動で送信します');
        let last = '';
        let stableSince = Date.now();
        const until = Date.now() + 10 * 60_000;
        while (Date.now() < until) {
          if (ctx.downloadDetected()) return { kind: 'download-started' };
          const s = await snapshot(page).catch(() => null);
          const v = s?.codeValue ?? '';
          if (v !== last) { last = v; stableSince = Date.now(); }
          if (v.length >= 3 && Date.now() - stableSince > 3000) break;
          await sleep(500);
        }
        ctx.humanDone();
        if (!last) return { kind: 'manual', reason: '画像認証が入力されませんでした' };
      }
    }

    // ---- 直リンクがあれば最優先 -------------------------------------------------
    const direct = pickDirectLink(snap, ctx.baseDomain, fname);
    if (direct && !hasDl2) {
      ctx.setStatus('自動操作中: 直リンクを取得しました');
      ctx.log(`direct link: ${direct}`);
      return { kind: 'direct', url: direct, filename: fname || undefined };
    }

    // ---- download2 フォームの送信 ----------------------------------------------
    if (hasDl2) {
      if (submitTried >= 3) return { kind: 'manual', reason: 'ダウンロードフォームを送信しても先に進みませんでした' };
      submitTried++;
      ctx.setStatus('自動操作中: ダウンロードリンクを要求');
      for (let i = 0; i < 10; i++) {
        const loc = page.locator(SUBMIT_BUTTONS[0]).first();
        if (await loc.count() > 0 && await loc.isEnabled().catch(() => false)) break;
        await sleep(500);
      }
      const clicked = await clickFirst(page, SUBMIT_BUTTONS, ctx.log);
      if (!clicked) return { kind: 'manual', reason: 'ダウンロードボタンが見つかりませんでした' };
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => { /* ignore */ });
      if (await waitForDownload(ctx, 5_000)) return { kind: 'download-started' };
      await sleep(1500);
      continue;
    }

    // ---- 無料ダウンロードの起点をクリック -----------------------------------------
    // XFileSharing の download1 フォーム、または「Free / Regular Download」相当の要素
    if (hasDl1 || snap.freeTrigger) {
      // ボタンが無効 / 非表示 = サイトのカウントダウン中のことが多い。押さずに待つ。
      // (uploady は押すと 120 秒数えてからフォームを自動送信する)
      if (!snap.freeTrigger || snap.freeTriggerDisabled) {
        waitStreak++;
        if (waitStreak > 240) return { kind: 'manual', reason: 'Free Download ボタンが押せる状態になりませんでした' };
        ctx.setStatus(`自動操作中: サイトの待ち時間${snap.countdown !== null ? ` ${snap.countdown} 秒` : ''}`);
        await sleep(1000);
        continue;
      }
      waitStreak = 0;
      if (step1Tried >= 3) return { kind: 'manual', reason: 'Free Download ボタンを押しても先に進みませんでした' };
      step1Tried++;
      ctx.setStatus(`自動操作中: 無料ダウンロードを選択${snap.freeTriggerText ? ` (${snap.freeTriggerText})` : ''}`);
      const clicked = await clickFirst(page, FREE_BUTTONS, ctx.log);
      if (!clicked) { await sleep(1000); continue; }

      const started = Date.now();
      let sawCountdown = false;
      while (Date.now() - started < 90_000) {
        await sleep(1000);
        if (ctx.downloadDetected()) return { kind: 'download-started' };
        const s = await snapshot(page).catch(() => null);
        if (!s) continue;
        if (s.wait || s.notFound) break;
        if (s.forms.some((f) => f.op === 'download2') || pickDirectLink(s, ctx.baseDomain, fname)) break;
        // ページが進んで人間判定が出た / 起点が変わった → 外側ループで扱う
        if (s.url !== snap.url) break;
        if (s.turnstile || s.recaptcha || s.hcaptcha || s.imageCaptcha) break;
        if (s.countdown !== null && s.countdown > 0) {
          sawCountdown = true;
          ctx.setStatus(`自動操作中: サイトの待ち時間 ${s.countdown} 秒`);
          continue;
        }
        if (sawCountdown) {
          // カウントダウン終了後にもう一度ボタンが必要なサイト向け
          await clickFirst(page, FREE_BUTTONS, ctx.log);
          sawCountdown = false;
          continue;
        }
        if (Date.now() - started > 12_000) break; // 変化なし → 外側ループで再判定
      }
      continue;
    }

    // ---- 認識できない ------------------------------------------------------
    // SPA の描画待ちや遷移直後のことがあるので、少し粘ってから諦める
    unknownStreak++;
    if (unknownStreak > 15) return { kind: 'manual', reason: '自動操作できるページ構造ではありませんでした' };
    ctx.setStatus('自動操作中: ページの読み込みを待っています');
    await sleep(1000);
  }
  return { kind: 'manual', reason: '自動操作が時間切れになりました' };
}
