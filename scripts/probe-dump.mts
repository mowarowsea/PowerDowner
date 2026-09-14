/**
 * data/debug に残った実機の HTML にドライバの目 (snapshot) を当てて、
 * 「どのボタンを押すつもりか」「人間を呼ぶつもりか」を確かめる。
 *
 *   node --import tsx scripts/probe-dump.mts data/debug/<id>-<時刻>.html [A|B|C] [ジョブの URL]
 *
 * サイトには触らない (オフラインのコンテキストに HTML を流し込むだけ)。
 * ページが動かなくなった時は、まずここでドライバの判断を見る。
 * A / B / C は frdl の 3 状態の再現 (1 歩目 / カウントダウン中 / 押せる状態)。
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { snapshot, pendingChallenge, pickDirectLink, fnameFromUrl } from '../src/drivers/xfs.js';

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('Edge / Chrome が見つかりません');

const file = process.argv[2];
const stage = (process.argv[3] ?? 'C').toUpperCase();
const jobUrl = process.argv[4] ?? '';
let html = fs.readFileSync(file, 'utf8');
// オフラインなので外部 CSS は当たらない。bootstrap 由来の「モーダルは隠れている」だけ補う
// (これが無いと、モーダルの中の hCaptcha まで「見えている」ことになる)
html = '<style>.modal.fade:not(.show){display:none!important}</style>' + html;

if (stage === 'A') {
  // 1 歩目: カウントダウンも hCaptcha も隠れていて、ボタンは NORMAL DOWNLOAD
  html = html
    .replace('id="free-captcha" style=""', 'id="free-captcha" style="display: none;"')
    .replace('>Start Download NOW</button>', '>NORMAL DOWNLOAD</button>')
    .replace('name="download_free" id="download_free" value="1"', 'name="download_free" id="download_free" value="0"');
}
if (stage === 'B') {
  // カウントダウン中: ボタンは disabled で「Almost Ready to Download」
  html = html
    .replace('id="countdown" style="display: none;"', 'id="countdown" style=""')
    .replace('<span class="seconds">1</span>', '<span class="seconds">44</span>')
    .replace('id="downloadbtnfree"', 'id="downloadbtnfree" disabled')
    .replace('>Start Download NOW</button>', '>Almost Ready to Download</button>');
}

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const ctx = await browser.newContext({ offline: true });
const page = await ctx.newPage();
await page.setContent(html, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);

const s = await snapshot(page);
const marked = await page.locator('[data-pd-submit="1"]').first()
  .evaluate((e) => (e as HTMLElement).outerHTML.slice(0, 140)).catch(() => null);

console.log(JSON.stringify({
  stage,
  forms: s.forms.map((f) => `${f.op || '-'}#${f.id || '-'}`),
  countdown: s.countdown,
  hcaptcha: s.hcaptcha,
  hcaptchaVisible: s.hcaptchaVisible,
  人間を呼ぶか: pendingChallenge(s),
  freeTrigger: s.freeTriggerText,
  submitTrigger: s.submitTriggerText,
  submitTriggerDisabled: s.submitTriggerDisabled,
  押す要素: marked,
  直リンク: pickDirectLink(s, jobUrl ? new URL(jobUrl).hostname.replace(/^www\./, '') : '', s.fname || fnameFromUrl(jobUrl)),
}, null, 1));
await browser.close();
