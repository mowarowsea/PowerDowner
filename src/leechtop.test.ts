import test from 'node:test';
import assert from 'node:assert/strict';
import { filenameFromUrl, isLeechtopUrl, parseLeechtopPage } from './resolvers/leechtop.js';

const PAGE = new URL('https://leechtop.com/4fd3e8f77acc2d75b26e22bb7937a7dc/');

test('leechtop の URL を見分ける', () => {
  assert.ok(isLeechtopUrl(PAGE));
  assert.ok(isLeechtopUrl(new URL('https://www.leechtop.com/x/')));
  assert.ok(!isLeechtopUrl(new URL('https://notleechtop.com/x/')));
});

test('配布ページから directDownload に要る値を抜く', () => {
  const html = `
    <a class="btn btn-lg btn-primary zing-disabled go-download-direct" style="min-width: 230px;" data-p="50114" data-mb="47.105999946594" href="#" rel="noreferrer">Loading in <span class="sec-count">70</span> seconds</a>
    <script>var zing = {"home_url":"https:\/\/leechtop.com","ajax_url":"https:\/\/leechtop.com\/wp-admin\/admin-ajax.php","plan_id":"0","nonce":"f046f646e0"};</script>`;
  assert.deepEqual(parseLeechtopPage(html, PAGE), {
    ajaxUrl: 'https://leechtop.com/wp-admin/admin-ajax.php', nonce: 'f046f646e0', p: '50114', mb: '47.105999946594',
  });
});

test('ボタンが無いページは null', () => {
  assert.equal(parseLeechtopPage('<html><body>not found</body></html>', PAGE), null);
});

test('直リンクの末尾から保存名を取る (空白入り)', () => {
  const url = new URL('https://g1.pubg-file.si:183/d/abc/IsekaiDeathGame v02s.zip').href;
  assert.equal(filenameFromUrl(url), 'IsekaiDeathGame v02s.zip');
});
