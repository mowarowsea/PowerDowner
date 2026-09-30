import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { searchSeries } from './pinax.js';

test('searchSeries: 棚を引いて綴りのまま返す。空の検索語では聞きに行かない', async () => {
  let asked = 0;
  const server = http.createServer((req, res) => {
    asked++;
    const url = new URL(req.url ?? '', 'http://x');
    assert.equal(url.pathname, '/api/series');
    assert.equal(url.searchParams.get('q'), 'ダリヤ');
    assert.equal(req.headers.authorization, 'Bearer tok');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      items: [{
        id: 7, title: '魔導具師ダリヤ ～Dahliya～', author: '甘岸久弥',
        folder: '[甘岸久弥] 魔導具師ダリヤ ～Dahliya～', fileCount: 9,
        shelf: { label: '続きが出ている — 10〜11巻が未所持' },
      }],
    }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const cfg = { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'tok', timeoutMs: 2000 };
  try {
    assert.deepEqual(await searchSeries(cfg, '  '), []);
    assert.equal(asked, 0);
    assert.deepEqual(await searchSeries(cfg, ' ダリヤ '), [{
      id: 7, title: '魔導具師ダリヤ ～Dahliya～', author: '甘岸久弥', files: 9,
      shelf: '続きが出ている — 10〜11巻が未所持',
    }]);
  } finally {
    server.close();
  }
});

test('searchSeries: 棚に届かない時は理由付きで投げる', async () => {
  await assert.rejects(
    searchSeries({ baseUrl: 'http://127.0.0.1:1', token: '', timeoutMs: 1000 }, 'x'),
    /pinax/,
  );
  await assert.rejects(searchSeries({ baseUrl: '', token: '', timeoutMs: 1000 }, 'x'), /未設定/);
});
