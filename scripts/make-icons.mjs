// public/*.svg から PNG / ICO を書き出す。
// ラスタライズは playwright-core + インストール済みの Edge/Chrome を使う (追加依存なし)。
// 縮小と .ico のまとめは Pillow に任せるので、実行には python + Pillow が要る。
//   node scripts/make-icons.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      readFileSync(p, { flag: 'r' });
      return p;
    } catch {
      // 次の候補へ
    }
  }
  throw new Error('Edge / Chrome が見つかりません');
}

const RENDER_PX = 512;

async function render(page, svgPath, outPath, transparent) {
  const svg = readFileSync(svgPath, 'utf8');
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
  await page.setContent(
    '<body style="margin:0"><img src="' + uri + '" width="' + RENDER_PX + '" height="' + RENDER_PX + '"></body>'
  );
  await page.locator('img').waitFor();
  const buf = await page.screenshot({ omitBackground: transparent });
  writeFileSync(outPath, buf);
}

const browser = await chromium.launch({ executablePath: findBrowser() });
const page = await browser.newPage({ viewport: { width: RENDER_PX, height: RENDER_PX } });
const work = mkdtempSync(join(tmpdir(), 'pd-icons-'));
const glyph = join(work, 'glyph.png');
const tile = join(work, 'tile.png');
await render(page, join(pub, 'favicon.svg'), glyph, true);
await render(page, join(pub, 'icon-tile.svg'), tile, false);
await browser.close();

// Pillow で縮小 (LANCZOS) と .ico のマルチサイズ束ね
const py = `
from PIL import Image
g = Image.open(r"${glyph}").convert("RGBA")
t = Image.open(r"${tile}").convert("RGBA")
def save(img, size, path):
    img.resize((size, size), Image.LANCZOS).save(path)
g.save(r"${join(pub, 'favicon.ico')}", sizes=[(16, 16), (32, 32), (48, 48)])
save(t, 180, r"${join(pub, 'apple-touch-icon.png')}")
save(t, 192, r"${join(pub, 'icon-192.png')}")
save(t, 512, r"${join(pub, 'icon-512.png')}")
`;
execFileSync('python', ['-c', py], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
console.log('public/ に favicon.ico, apple-touch-icon.png, icon-192.png, icon-512.png を書き出しました');
