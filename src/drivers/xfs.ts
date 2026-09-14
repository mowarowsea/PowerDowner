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
  /** このジョブのページが今までに開いたポップアップの数 (広告に吸われたクリックの判定用) */
  popupCount(): number;
  /** 操作対象のページを前面に戻す。ポップアップに奪われたフォーカスを取り返す */
  focus(): void;
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
  /**
   * 人間判定のウィジェットが**今見えているか**。DOM にあるだけでは人間を呼ばない。
   * frdl は最初のページから hCaptcha を DOM に置いたまま隠していて、
   * 「押すものが画面に無いのに押してくださいと出る」ことになる。
   */
  turnstileVisible: boolean;
  recaptchaVisible: boolean;
  hcaptchaVisible: boolean;
  imageCaptchaVisible: boolean;
  anchors: { href: string; text: string }[];
  bodyText: string;
  /** 「無料ダウンロード」に相当する要素を見つけて data-pd-free で印を付けたか */
  freeTrigger: boolean;
  freeTriggerText: string;
  /** その要素が disabled (サイト側のカウントダウン中) か */
  freeTriggerDisabled: boolean;
  /** download2 の送信ボタンを見つけて data-pd-submit で印を付けたか */
  submitTrigger: boolean;
  submitTriggerText: string;
  /** その送信ボタンが disabled (カウントダウン中) か */
  submitTriggerDisabled: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 数字だけの要素を持たないカウントダウン (dailyuploads の「Seconds remaining: 32」) を本文から拾う。
 * SNAPSHOT_JS へは source を埋め込む。ブラウザ内コードは文字列なので、正規表現をそこへ直接書くと
 * エスケープが 1 段ずれて静かに壊れる。
 */
export const COUNTDOWN_TEXT_RE =
  /(?:seconds?\s+remaining|please\s+wait)[^0-9]{0,12}([0-9]{1,3})|([0-9]{1,3})\s*(?:seconds?|secs?)\s+remaining/i;

/**
 * ボタンの文言と id の判定。**ブラウザ内コードには source を埋め込む** (COUNTDOWN_TEXT_RE と同じ理由)。
 * TS 側に置いてあるのは、実機の HTML から拾った文言をテストで固定するため。
 */

/** 「無料ダウンロード」の入口に見える文言 */
export const FREE_TEXT_RE =
  /free download|regular download|slow speed download|slow download|download for free|normal download|無料ダウンロード|低速ダウンロード|通常ダウンロード/i;

/** 有料へ誘う側。押してはいけない (frdl の「FREE PREMIUM DOWNLOAD」もこちら) */
export const BAD_TEXT_RE = /premium|turbo|high speed|upgrade|buy|subscribe|プレミアム|高速|購入/i;

/** ダウンロードを確定させるボタンの文言 (download2 の送信) */
export const SUBMIT_TEXT_RE =
  /start download|download now|create download link|get download link|generate download|proceed to download|continue to download|almost ready|click here to download|ダウンロードを開始|ダウンロードリンクを作成/i;

/** id / name / class が「本物のダウンロードボタン」を示すもの */
export const TRIGGER_ID_RE =
  /free_dwn|method_free|fbtn|freebtn|free_btn|btnfree|btn_free|slow_btn|download_free|dlfree|downloadbtn|btn_download/i;

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
  var visSel = function (sel) {
    var l = document.querySelectorAll(sel);
    for (var i = 0; i < l.length; i++) if (vis(l[i])) return true;
    return false;
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
  // 数字だけの要素が無い書き方 (dailyuploads の「Seconds remaining: 32」) は本文から拾う
  if (countdown === null) {
    var cm = bodyText.match(new RegExp(${JSON.stringify(COUNTDOWN_TEXT_RE.source)}, 'i'));
    if (cm) countdown = Number(cm[1] || cm[2]);
  }

  // ---- 「無料ダウンロード」の起点を探して印を付ける ----
  // XFileSharing のフォームが無いサイト (turbobit の Vue UI など) でも 1 歩目を進められるようにする。
  var FREE_RE = new RegExp(${JSON.stringify(FREE_TEXT_RE.source)}, 'i');
  var BAD_RE = new RegExp(${JSON.stringify(BAD_TEXT_RE.source)}, 'i');
  var SUBMIT_RE = new RegExp(${JSON.stringify(SUBMIT_TEXT_RE.source)}, 'i');
  var marked = document.querySelectorAll('[data-pd-free]');
  for (var mi = 0; mi < marked.length; mi++) marked[mi].removeAttribute('data-pd-free');
  // id / name が「本物の無料ボタン」を示すものを最優先する。
  // 「Continue with Free Download」のような案内リンクより確実。
  var ID_RE = new RegExp(${JSON.stringify(TRIGGER_ID_RE.source)}, 'i');
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

  // ---- ダウンロードリンク生成ボタン (download2 フォームの送信) ----
  // カウントダウン中は disabled にしておくサイトがある (dailyuploads の
  // 「Create Download Link」)。押せる状態かどうかをドライバに伝えて、空押しを避ける。
  //
  // **op=download2 のフォームは 1 ページに複数ある。** frdl は 3 つ持っていて、
  // 先頭は有料枠 (押してはいけない)、2 つ目が無料枠、3 つ目は隠れたモーダル。
  // 先頭を掴むと「押せるボタンが無い」と誤解して手動モードに落ちる。
  // 押せるボタンを持っているフォームを選ぶ。
  var submitTrigger = false;
  var submitTriggerText = '';
  var submitTriggerDisabled = false;
  var marked2 = document.querySelectorAll('[data-pd-submit]');
  for (var m2 = 0; m2 < marked2.length; m2++) marked2[m2].removeAttribute('data-pd-submit');

  // needText: 文言か id で確証が取れたものだけを拾う (フォームの外を探すとき用)
  var pickSubmit = function (root, needText) {
    var sbs = root.querySelectorAll('#btn_download, button, input[type="submit"], input[type="button"]');
    var pick = null;
    var pickScore = 0;
    for (var si = 0; si < sbs.length; si++) {
      var b = sbs[si];
      if (!vis(b)) continue;
      var btxt = (b.innerText || b.value || '').trim();
      var bidn = (b.getAttribute('id') || '') + ' ' + (b.getAttribute('name') || '') + ' ' + (typeof b.className === 'string' ? b.className : '');
      if (BAD_RE.test(btxt)) continue;
      var sc = 0;
      if (SUBMIT_RE.test(btxt)) sc += 2;
      if (ID_RE.test(bidn)) sc += 2;
      if (FREE_RE.test(btxt)) sc += 1;
      if (b.type === 'submit') sc += 1;
      if (needText && sc === 0) continue;
      if (b.disabled) sc -= 0.5; // 押せるものを優先しつつ、カウントダウン中の本命も拾う
      if (!pick || sc > pickScore) { pickScore = sc; pick = b; }
    }
    return pick;
  };

  var sb = null;
  for (var f2 = 0; f2 < fs.length && !sb; f2++) {
    var op2 = fs[f2].querySelector('input[name="op"]');
    if (op2 && op2.value === 'download2') sb = pickSubmit(fs[f2], false);
  }
  // フォームの外に置かれたボタン (JS で form.submit() を呼ぶ作り) も拾う
  if (!sb) sb = pickSubmit(document, true);
  if (sb) {
    sb.setAttribute('data-pd-submit', '1');
    submitTrigger = true;
    submitTriggerText = ((sb.innerText || sb.value || '').trim()).slice(0, 60);
    submitTriggerDisabled = !!sb.disabled;
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
    // 画面に出ているものだけを「人間の番」とみなす。隠れたウィジェットで人間を呼ぶと、
    // 押すものが無い画面を見せることになる (frdl は 1 歩目から hCaptcha を隠して置いている)
    turnstileVisible: visSel('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'),
    recaptchaVisible: !hasHcaptcha && visSel('.g-recaptcha, iframe[src*="recaptcha"]'),
    hcaptchaVisible: visSel('.h-captcha, iframe[src*="hcaptcha.com"]'),
    imageCaptchaVisible: visSel('input[name="code"], input[name="captcha_response"]'),
    anchors: anchors,
    bodyText: bodyText.slice(0, 4000),
    freeTrigger: freeTrigger,
    freeTriggerText: freeTriggerText,
    freeTriggerDisabled: freeTriggerDisabled,
    submitTrigger: submitTrigger,
    submitTriggerText: submitTriggerText,
    submitTriggerDisabled: submitTriggerDisabled
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
  for (const m of text.matchAll(/(\d+)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?|std|h|m|s)\b/gi)) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u.startsWith('h') || u === 'std') ms += n * 3600_000;
    else if (u.startsWith('m')) ms += n * 60_000;
    else ms += n * 1000;
  }
  return ms;
}

/**
 * ページ URL からファイル名を拾う。`/wiwex9e7i9sh/Goblin_Slayer_v11.rar.html` → `goblin_slayer_v11.rar`。
 *
 * XFileSharing は `<input name="fname">` を置くことが多いが、frdl のように置かないサイトもある。
 * ファイル名が分からないと、別ドメインで配られる直リンク (e21.urleecher.com) を本物だと
 * 言い切れない。URL に入っている分だけでも拾っておく。
 */
export function fnameFromUrl(url: string): string {
  let last = '';
  try {
    last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
  } catch {
    return '';
  }
  // 「.html」を被せる作り (frdl, katfile) を剥がす
  const bare = last.replace(/\.(html?|php)$/i, '');
  return FILE_EXT.test(bare) ? bare.toLowerCase() : '';
}

/**
 * 比較用にファイル名をならす。区切り文字だけを落とす。
 *
 * サイトはページ URL とファイル本体で区切りを変えてくる。frdl は
 * ページが `Goblin_Slayer_Manga_v15.rar.html`、直リンクが `Goblin Slayer Manga v15.rar` で、
 * そのまま比べると別物になる。英数字以外を全部落とすと日本語のファイル名が空になり、
 * 「何にでも一致する」危険な比較になるので、落とすのは区切り記号だけにする。
 */
export function normName(s: string): string {
  let t = s;
  try { t = decodeURIComponent(s); } catch { /* 壊れたエスケープはそのまま */ }
  return t.toLowerCase().replace(/[\s_.\-+~'"()\[\]{}#,!&]+/g, '');
}

/**
 * 今この画面で人間に押してもらう必要がある判定。無ければ null。
 *
 * **見えているウィジェットだけを見る。** DOM にあるだけで人間を呼ぶと、frdl のように
 * 1 歩目から hCaptcha を隠して置いているサイトで「押すものが画面に無いのに人間待ち」になる。
 */
export function pendingChallenge(snap: Snapshot): 'turnstile' | 'recaptcha' | 'hcaptcha' | 'image' | null {
  if (snap.turnstileVisible && !snap.turnstileToken) return 'turnstile';
  if (snap.recaptchaVisible && !snap.recaptchaToken) return 'recaptcha';
  if (snap.hcaptchaVisible && !snap.hcaptchaToken) return 'hcaptcha';
  if (snap.imageCaptchaVisible && !snap.codeValue) return 'image';
  return null;
}

/** 押す対象はスナップショットが data-pd-free で選んでいるので、それだけを使う */
const FREE_BUTTONS = ['[data-pd-free="1"]'];

const SUBMIT_BUTTONS = [
  '[data-pd-submit="1"]',
  'form:has(input[name="op"][value="download2"]) #btn_download',
  'form:has(input[name="op"][value="download2"]) button[type="submit"]',
  'form:has(input[name="op"][value="download2"]) input[type="submit"]',
  'form:has(input[name="op"][value="download2"]) button:not([type="button"])',
  '#btn_download',
];

export const FILE_EXT = /\.(rar|zip|7z|tar|gz|mp4|mkv|avi|wmv|mov|mp3|flac|pdf|iso|exe|bin|dat|apk|epub|cbz|cbr|r\d\d|part\d+)(\?|$)/i;

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
 * 広告のポップアンダーに吸われるクリックへの対処。
 *
 * dailyuploads のようなサイトは、最初の何回かのクリックが広告タブを開くだけで
 * 本来の遷移をしない (人間も「3〜4 回しつこく押す」ことになる)。ポップアップが
 * 開いただけの空振りは押した回数に数えず、間を置かずに押し直す。
 *
 * 戻り値は「本来の遷移を起こしたかもしれないクリックができたか」。
 */
async function clickPersistently(ctx: DriverContext, selectors: string[], maxClicks = 6): Promise<boolean> {
  for (let i = 0; i < maxClicks; i++) {
    const before = ctx.popupCount();
    ctx.focus();
    if (!(await clickFirst(ctx.page, selectors, ctx.log))) return i > 0;
    await sleep(1200);
    if (ctx.downloadDetected()) return true;
    if (ctx.popupCount() === before) return true;
    ctx.log(`click swallowed by popup (${i + 1}/${maxClicks})`);
  }
  return true;
}

/**
 * ファイルらしい URL を選ぶ。
 *
 * 直リンクは別ドメインで配られることが多い (frdl.hk → e21.urleecher.com) ので、
 * 同一サイト条件では本物を捨ててしまう。代わりに「期待するファイル名と一致するか」
 * 「パスがファイルを指しているか」で判断し、別ドメインには確証を多めに要求する。
 */
export function pickDirectLink(snap: Snapshot, baseDomain: string, fname: string): { href: string; score: number } | null {
  const want = normName(fname);
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
    if (want && normName(pathname).endsWith(want)) score += 4;          // ファイル名そのもの
    else if (want && normName(a.href).includes(want)) score += 3;
    if (isFilePath) score += 1;
    if (/download/i.test(a.text)) score += 1;
    if (/\/d\/|\/dl\/|\/files\/|\/download\//i.test(u.pathname)) score += 1;

    // 別ドメインを許す代わりに、パスがファイルを指していることを必須にする
    if (!sameSite && !isFilePath) continue;
    if (score >= (sameSite ? 2 : 3) && (!best || score > best.score)) best = { href: a.href, score };
  }
  return best;
}

/** ファイル名まで一致した = フォームが残っていても本物とみなせる確度 */
const DIRECT_SURE = 4;

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
async function waitForChallenge(
  ctx: DriverContext,
  kind: 'turnstile' | 'recaptcha' | 'hcaptcha',
  maxMs: number,
  countdown: number | null = null,
): Promise<boolean> {
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
      // サイトのカウントダウン中なら、それも伝える (押すのを待たせている訳ではないと分かる)
      const tail = countdown !== null && countdown > 0
        ? `。サイトの待ち時間 (${countdown} 秒) はその間に進みます` : '';
      ctx.askHuman(`あなたの番: ブラウザの ${label} のチェックを押してください。押せば続きは自動です${tail}`);
      // 画面外にあると「押すものが無い」ように見える。1 回だけ寄せる
      await ctx.page.locator('.h-captcha, .g-recaptcha, .cf-turnstile').first()
        .scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => { /* ignore */ });
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
  const urlFname = fnameFromUrl(ctx.url);
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

    // ---- 人間判定 -------------------------------------------------------------
    // **カウントダウンより先に出す。** サイトが 60 秒数えている間にチェックを押して
    // もらえれば、人間の待ちとサイトの待ちが重なる (frdl はこれで待ち時間が消える)。
    // 1 歩目のページ (download1 フォームがある) では、Cloudflare の常時ウィジェットに
    // 反応して無駄に人間を呼ばないよう、判定待ちはしない。
    const challenge = hasDl1 ? null : pendingChallenge(snap);
    if (challenge && challenge !== 'image') {
      const label = challenge === 'turnstile' ? 'Turnstile' : challenge === 'recaptcha' ? 'reCAPTCHA' : 'hCaptcha';
      if (!(await waitForChallenge(ctx, challenge, 10 * 60_000, snap.countdown))) {
        return { kind: 'manual', reason: `${label} が通過しませんでした` };
      }
      continue;
    }

    // ---- サイトのカウントダウン -----------------------------------------------
    if (snap.countdown !== null && snap.countdown > 0 && !hasDl1) {
      ctx.setStatus(`自動操作中: サイトの待ち時間 ${snap.countdown} 秒`);
      await sleep(1000);
      continue;
    }

    if (challenge === 'image') {
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

    // ---- 直リンクがあれば最優先 -------------------------------------------------
    // download2 のフォームが残っていても、次のどちらかなら直リンクが本物:
    //   - ファイル名まで一致している
    //   - そのフォームに押せるボタンが無い (frdl の最終ページは form の中に
    //     <a class="btn">Download Now</a> を置くだけで、送信ボタンが存在しない)
    const direct = pickDirectLink(snap, ctx.baseDomain, fname || urlFname);
    if (direct && (!hasDl2 || !snap.submitTrigger || direct.score >= DIRECT_SURE)) {
      ctx.setStatus('自動操作中: 直リンクを取得しました');
      ctx.log(`direct link: ${direct.href} (score ${direct.score})`);
      return { kind: 'direct', url: direct.href, filename: fname || undefined };
    }

    // ---- download2 フォームの送信 ----------------------------------------------
    if (hasDl2) {
      // カウントダウンが終わるまでボタンを disabled にするサイトがある
      // (dailyuploads の「Create Download Link」)。押せるまで待つ。空押しすると
      // 試行回数だけ減って人間待ちに落ちる。
      if (snap.submitTrigger && snap.submitTriggerDisabled) {
        waitStreak++;
        if (waitStreak > 300) return { kind: 'manual', reason: 'ダウンロードボタンが押せる状態になりませんでした' };
        ctx.setStatus(`自動操作中: サイトの待ち時間${snap.countdown !== null ? ` ${snap.countdown} 秒` : ''}`);
        await sleep(1000);
        continue;
      }
      waitStreak = 0;
      if (submitTried >= 5) return { kind: 'manual', reason: 'ダウンロードボタンを押しても先に進みませんでした' };
      submitTried++;
      ctx.setStatus(`自動操作中: ダウンロードを要求${snap.submitTriggerText ? ` (${snap.submitTriggerText})` : ''}`);
      for (let i = 0; i < 10; i++) {
        const loc = page.locator(SUBMIT_BUTTONS[0]).first();
        if (await loc.count() > 0 && await loc.isEnabled().catch(() => false)) break;
        await sleep(500);
      }
      const clicked = await clickPersistently(ctx, SUBMIT_BUTTONS);
      if (!clicked) {
        // 押せなかった。無効化された直後や描画待ちのことがあるので、回数を使い切るまで粘る
        ctx.log('submit button not clickable');
        await sleep(1500);
        continue;
      }
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
      if (step1Tried >= 5) return { kind: 'manual', reason: 'Free Download ボタンを押しても先に進みませんでした' };
      step1Tried++;
      ctx.setStatus(`自動操作中: 無料ダウンロードを選択${snap.freeTriggerText ? ` (${snap.freeTriggerText})` : ''}`);
      const clicked = await clickPersistently(ctx, FREE_BUTTONS);
      if (!clicked) { await sleep(1000); continue; }

      const started = Date.now();
      let sawCountdown = false;
      while (Date.now() - started < 90_000) {
        await sleep(1000);
        if (ctx.downloadDetected()) return { kind: 'download-started' };
        const s = await snapshot(page).catch(() => null);
        if (!s) continue;
        if (s.wait || s.notFound) break;
        if (s.forms.some((f) => f.op === 'download2') || pickDirectLink(s, ctx.baseDomain, fname || urlFname)) break;
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
          await clickPersistently(ctx, FREE_BUTTONS);
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
