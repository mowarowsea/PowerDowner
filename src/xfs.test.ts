import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWait, snapshot, COUNTDOWN_TEXT_RE, FREE_TEXT_RE, BAD_TEXT_RE, SUBMIT_TEXT_RE,
  TRIGGER_ID_RE, fnameFromUrl, pendingChallenge, pickDirectLink, normName, type Snapshot,
} from './drivers/xfs.js';

/** snapshot() がブラウザへ渡す文字列を横取りする偽ページ */
async function snapshotJs(): Promise<string> {
  let js = '';
  const page = { evaluate: (code: string) => { js = code; return Promise.resolve({}); } };
  await snapshot(page as never);
  return js;
}

test('ブラウザ内で動かすコードは構文エラーを含まない', async () => {
  // 文字列で渡すコードは、実行するまで壊れていても気づけない。構文だけでも見ておく。
  const js = await snapshotJs();
  assert.doesNotThrow(() => new Function('return ' + js));
});

test('埋め込んだ正規表現がブラウザ側で復元できる', async () => {
  const js = await snapshotJs();
  assert.ok(js.includes(JSON.stringify(COUNTDOWN_TEXT_RE.source)));
});

test('数字だけの要素が無いカウントダウンを本文から拾う (dailyuploads)', () => {
  const body = [
    'Your file is ready',
    'Click the button below to generate the direct download link.',
    'Seconds remaining: 32',
    'Create Download Link',
    'Skip the wait with Premium',
    'Faster downloads, no wait time and no ads on every link you create.',
    'Faster speed  No waiting time  No ads',
  ].join('\n');
  const m = body.match(COUNTDOWN_TEXT_RE);
  assert.equal(Number(m![1] ?? m![2]), 32);
  assert.equal(Number('5 seconds remaining'.match(COUNTDOWN_TEXT_RE)![2]), 5);
  // 待ち時間を売り文句にしているだけの行に反応しない
  assert.equal('No waiting time. No ads.'.match(COUNTDOWN_TEXT_RE), null);
});

test('無料ダウンロードの間隔は ms に直せる', () => {
  assert.equal(parseWait('120 minutes'), 120 * 60_000);
  assert.equal(parseWait('1 hour, 50 minutes, 17 seconds'), 3600_000 + 50 * 60_000 + 17_000);
  // XFS の表記ゆれ。読めないと 0 ms になり、制限中なのに押し続けてしまう
  assert.equal(parseWait('30 secs'), 30_000);
  assert.equal(parseWait('45 mins'), 45 * 60_000);
  assert.equal(parseWait(''), 0);
});

test('埋め込んだ文言の正規表現もブラウザ側で復元できる', async () => {
  const js = await snapshotJs();
  for (const re of [FREE_TEXT_RE, BAD_TEXT_RE, SUBMIT_TEXT_RE, TRIGGER_ID_RE]) {
    assert.ok(js.includes(JSON.stringify(re.source)), re.source.slice(0, 30));
  }
});

test('frdl のボタンを 3 つの状態すべてで見分ける', () => {
  // 実機の HTML (data/debug) から拾った文言。1 つのボタンが押すたびに文言を変える:
  // NORMAL DOWNLOAD → Almost Ready to Download (カウントダウン中) → Start Download NOW
  assert.ok(FREE_TEXT_RE.test('NORMAL DOWNLOAD'));
  assert.ok(SUBMIT_TEXT_RE.test('Start Download NOW'));
  assert.ok(SUBMIT_TEXT_RE.test('Almost Ready to Download'));
  assert.ok(TRIGGER_ID_RE.test('downloadbtnfree btn btn-outline-primary'));
  // 同じページの有料枠。押すと課金の導線に入るので必ず外す
  assert.ok(BAD_TEXT_RE.test('FREE PREMIUM DOWNLOAD'));
  // 他サイトの文言も引き続き通ること
  assert.ok(SUBMIT_TEXT_RE.test('Create Download Link'));
  assert.ok(FREE_TEXT_RE.test('Slow Speed Download'));
  assert.ok(BAD_TEXT_RE.test('Premium Download'));
});

test('fname が無いサイトでも URL からファイル名を拾う (frdl)', () => {
  assert.equal(
    fnameFromUrl('https://frdl.by/wiwex9e7i9sh/Goblin_Slayer_Manga_v11.rar.html'),
    'goblin_slayer_manga_v11.rar',
  );
  assert.equal(fnameFromUrl('https://katfile.com/abc123/foo%20bar.zip'), 'foo bar.zip');
  // ファイルを指していない URL からは拾わない (拾うと直リンク判定が甘くなる)
  assert.equal(fnameFromUrl('https://frdl.by/'), '');
  assert.equal(fnameFromUrl('https://example.com/download/index.html'), '');
  assert.equal(fnameFromUrl('not a url'), '');
});

const SNAP: Snapshot = {
  url: 'https://frdl.by/x/y.rar.html', title: '', forms: [], fname: '', wait: '', notFound: false,
  countdown: null, turnstile: false, turnstileToken: '', recaptcha: false, recaptchaToken: '',
  hcaptcha: false, hcaptchaToken: '', imageCaptcha: false, codeValue: '',
  turnstileVisible: false, recaptchaVisible: false, hcaptchaVisible: false, imageCaptchaVisible: false,
  anchors: [], bodyText: '', freeTrigger: false, freeTriggerText: '', freeTriggerDisabled: false,
  submitTrigger: false, submitTriggerText: '', submitTriggerDisabled: false,
};

test('隠れている人間判定では人間を呼ばない', () => {
  // frdl は 1 歩目のページから hCaptcha を DOM に置いて隠している。
  // ここで人間を呼ぶと「押すものが画面に無いのにあなたの番」と出てしまう
  assert.equal(pendingChallenge({ ...SNAP, hcaptcha: true }), null);
  assert.equal(pendingChallenge({ ...SNAP, hcaptcha: true, hcaptchaVisible: true }), 'hcaptcha');
  // トークンが入ったら用済み
  assert.equal(pendingChallenge({ ...SNAP, hcaptcha: true, hcaptchaVisible: true, hcaptchaToken: 'x' }), null);
  assert.equal(pendingChallenge({ ...SNAP, imageCaptcha: true, imageCaptchaVisible: true }), 'image');
  assert.equal(pendingChallenge(SNAP), null);
});

test('区切りが違うだけのファイル名は同じものとして扱う', () => {
  // ページ URL は下線、直リンクは空白 (frdl)。落とすのは区切りだけ
  assert.equal(normName('Goblin_Slayer_Manga_v15.rar'), normName('Goblin Slayer Manga v15.rar'));
  assert.equal(normName('[Group] Title - 01.zip'), 'grouptitle01zip');
  // 英数字以外を全部落とすと日本語名が空になり「何にでも一致」してしまう
  assert.equal(normName('作品名 第15巻.rar'), '作品名第15巻rar');
  assert.notEqual(normName('作品名 第15巻.rar'), '');
});

test('別ドメインで配られる直リンクを拾う (frdl の最終ページ)', () => {
  const snap: Snapshot = {
    ...SNAP,
    url: 'https://frdl.my/w98fdxmefiiy/Goblin_Slayer_Manga_v15.rar.html',
    forms: [{ op: 'download2', id: '' }],
    anchors: [
      { href: 'https://frdl.my/?op=report_file&id=w98fdxmefiiy', text: 'Report file' },
      { href: 'https://e21.urleecher.com/d/cjsac644shz/Goblin%20Slayer%20Manga%20v15.rar', text: 'Download Now' },
      { href: 'https://www.freedownloadmanager.org/', text: 'here' },
    ],
  };
  const want = fnameFromUrl(snap.url);
  const got = pickDirectLink(snap, 'frdl.my', want);
  assert.equal(got?.href, 'https://e21.urleecher.com/d/cjsac644shz/Goblin%20Slayer%20Manga%20v15.rar');
  // ファイル名まで一致した確度。ここが 4 未満だと、フォームが残っているページで見送られる
  assert.ok(got!.score >= 4, `score=${got?.score}`);

  // 名前が分からなくても、ファイルを指す別ドメインのリンクなら拾えること
  assert.ok(pickDirectLink(snap, 'frdl.my', ''));
  // 宣伝リンクは拾わない
  assert.equal(pickDirectLink({ ...snap, anchors: [snap.anchors[0], snap.anchors[2]] }, 'frdl.my', want), null);
});
