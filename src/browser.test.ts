import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adUrlRe, popupGuardScript, listedHost, blocksNavigation } from './engines/browser.js';

/**
 * popupGuardScript をブラウザの外で動かす。
 * window / location / console を差し替えるだけで動くように書いてあるので、
 * 実ブラウザを起動しなくても「何を通して何を潰すか」を確かめられる。
 */
function runGuard(base: string, href: string) {
  const opened: string[] = [];
  const warned: string[] = [];
  const win: Record<string, unknown> = { open: (u: string) => { opened.push(u); return { real: true }; } };
  const console = { warn: (...a: unknown[]) => { warned.push(a.map(String).join(' ')); } };
  new Function('window', 'location', 'console', popupGuardScript(base))(win, { href }, console);
  return { open: win.open as (u?: string) => unknown, opened, warned };
}

test('ブラウザ内で動かすコードは構文エラーを含まない (popupGuard)', () => {
  // 文字列で渡すコードは、実行するまで壊れていても気づけない
  assert.doesNotThrow(() => new Function('return ' + popupGuardScript('dailyuploads.net')));
});

test('サイト自身の window.open は通す', () => {
  const g = runGuard('dailyuploads.net', 'https://dailyuploads.net/abc');
  assert.deepEqual(g.open('https://dailyuploads.net/x'), { real: true });
  assert.deepEqual(g.open('https://www.dailyuploads.net/x'), { real: true });
  assert.deepEqual(g.open('/relative'), { real: true });
  assert.equal(g.opened.length, 3);
  assert.equal(g.warned.length, 0);
});

test('他所へ向かう window.open は開かせず、目印を残す', () => {
  const g = runGuard('dailyuploads.net', 'https://dailyuploads.net/abc');
  const w = g.open('https://ads.example/pop') as { closed: boolean };
  assert.equal(g.opened.length, 0);
  assert.equal(w.closed, true);
  assert.equal(g.warned.length, 1);
  assert.match(g.warned[0], /__pd_popup_blocked/);
});

test('引数なしの window.open (about:blank から飛ぶポップアンダー) も潰す', () => {
  const g = runGuard('dailyuploads.net', 'https://dailyuploads.net/abc');
  const w = g.open() as { document: { write: (s: string) => void } };
  assert.equal(g.opened.length, 0);
  // null を返すとページ側のコードが例外で止まる。触っても無害なダミーであること
  assert.doesNotThrow(() => w.document.write('<html>'));
});

test('遮断するのは広告配信網だけ (サイト本体と CDN には触らない)', () => {
  const re = adUrlRe();
  assert.ok(re.test('https://popads.net/x.js'));
  assert.ok(re.test('https://cdn.exoclick.com/a'));
  assert.ok(!re.test('https://dailyuploads.net/x'));
  assert.ok(!re.test('https://cdn.freedl.ink/app.js'));
  // 名前に広告ドメインを含むだけの別サイトを巻き込まない
  assert.ok(!re.test('https://notpopads.net/x'));
});

test('config の adHosts を足せる', () => {
  const re = adUrlRe(['new-ads.example', ' UPPER.example ']);
  assert.ok(re.test('https://new-ads.example/pop'));
  assert.ok(re.test('https://x.upper.example/pop'));
  assert.ok(re.test('https://popads.net/x'));   // 既定のリストも残る
});

test('広告対策のホスト指定は www 付きでも書ける', () => {
  assert.ok(listedHost('dailyuploads.net', ['dailyuploads.net']));
  assert.ok(listedHost('dailyuploads.net', ['www.dailyuploads.net']));
  assert.ok(!listedHost('dailyuploads.net', ['uploady.io']));
  assert.ok(!listedHost('dailyuploads.net', ['', '  ']));
});

test('待ち時間中に他所へ飛ばす遷移は止める', () => {
  const bases = ['dailyuploads.net'];
  assert.ok(blocksNavigation('https://ad.example/redirect?u=1', bases));
  assert.ok(blocksNavigation('http://tracker.example/', bases));
});

test('サイト自身の遷移と直リンクへの遷移は止めない', () => {
  const bases = ['dailyuploads.net'];
  assert.ok(!blocksNavigation('https://dailyuploads.net/8h3drj3d1y4g', bases));
  assert.ok(!blocksNavigation('https://s12.dailyuploads.net/d/xxxx/file.rar', bases));
  // 直リンクは別ドメインで配られることがある。止めるとダウンロードが始まらない
  assert.ok(!blocksNavigation('https://e21.urleecher.com/d/abc/Goblin%20Slayer%20v15.rar', bases));
  // about:blank や壊れた URL に手を出さない
  assert.ok(!blocksNavigation('about:blank', bases));
  assert.ok(!blocksNavigation('', bases));
});

test('移動先が同一サイト扱いに足されたら、そのドメインへの遷移も通る', () => {
  // frdl.io → frdl.hk のように bases が増えていく作り
  assert.ok(blocksNavigation('https://frdl.hk/x', ['frdl.io']));
  assert.ok(!blocksNavigation('https://frdl.hk/x', ['frdl.io', 'frdl.hk']));
});
