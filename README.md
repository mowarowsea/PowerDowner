# PowerDowner

URL を貼るだけで、直リンク・CivitAI・ワンクリックホスター (rapidgator, katfile, turbobit など) を
自動で振り分けてダウンロードする自宅用の Web 司令塔。

```
URL 投入 → Router → aria2 (直リンク / CivitAI)         … 分割・再開・無限リトライ
                  → JDownloader 2 (ホスター、ローカル API) … プラグイン任せ。GUI 無し (headless) で常駐する
                  → ブラウザ引き継ぎ (Edge を Playwright で操作) … JD2 が扱えない人間判定 (Cloudflare Turnstile など) は
                                                              人間が実ブラウザで通し、始まったダウンロードを aria2 が引き継ぐ
```

katfile のように無料ダウンロードが Cloudflare Turnstile で守られているサイトは、JD2 では「外部 (有料) ソルバーが必要」として
ブロックされる。その場合は自動でブラウザ引き継ぎに回る。`config.json` の `browser.hosts` に書いたドメインは最初からブラウザへ行く。

- Node.js 24 以上だけあれば動く。SQLite は Node 内蔵のものを使う。
- aria2c.exe、JRE、JDownloader.jar は `tools/` に「置くだけ」。インストール不要。
- ユーザーはデータ切り分け用の簡易モデル (名前 + 既定フォルダ)。パスワードなし。
- **起動するのは PowerDowner 1 個だけ。** aria2 も JDownloader も PowerDowner が起動し、終了時に片付ける。

将来の構想 (DryEyes 連携、ntfy 通知、ミラーの優先度選択、LocalLauncher への統合) と、
そのためにここを壊すなという前提は [docs/ROADMAP.md](docs/ROADMAP.md) にまとめてある。

## ホスター別の実績

| ホスター | 経路 | 状況 |
|---|---|---|
| dailyuploads | JD2 | 完走を確認 |
| uploady | ブラウザ | JD2 は hCaptcha で不可。ドライバの自動操作で完走を確認 |
| frdl | ブラウザ | frdl.hk へリダイレクト。hCaptcha 1 回で直リンクまで到達。無料は 10 分間隔 |
| katfile | **自動不可** | Turnstile が CDP を検出して弾く。下記の手動リレーで運用する |
| mexa.sh | JD2 | まず JD2 に任せる。詰まったら自動でブラウザへ。サイトが Cloudflare 522 を返す時期があり、その場合は 10 分ごとに自動で試し直す |
| turbobit | ブラウザ | Vue SPA。Regular Download から進む |
| rapidgator | **自動不可** | katfile と同じく Turnstile が描画されない (枠だけ出て中身が空)。人間が見ても押すチェックが無いので、待っても通らない。優先度は katfile の手前まで下げてある |

JD2 が CAPTCHA の種類 (hCaptcha / reCAPTCHA / Turnstile) で詰まった場合と、
「wrong captcha」「Blocked by Cloudflare」で進まなくなった場合は、自動でブラウザ経路へ切り替わる。
JD2 のブラウザ解決用の拡張機能は配布終了しているため、これらは JD2 に任せない。

headless 運用では JD2 に CAPTCHA ダイアログを出す画面が無いので、**種類を問わず**ブラウザ経路へ回る
(`jd2.headless` を `false` にすると GUI 起動になり、従来どおり JD2 の画面で解ける)。

## セットアップ

```bash
npm install
powershell -ExecutionPolicy Bypass -File scripts\fetch-tools.ps1
```

`fetch-tools.ps1` が `tools/aria2/aria2c.exe`、`tools/jre/`、`tools/jd2/JDownloader.jar` を用意し、
JD2 の Deprecated API (127.0.0.1:3128) を有効化する設定も書く。

必要なら `config.example.json` を `config.json` にコピーして編集する (ポート、aria2 の並列数、JD2 に回すドメインなど)。

## 起動

```bash
npm run dev               # PowerDowner → http://localhost:3939/
```

JD2 は PowerDowner が勝手に起動する (`jd2.autoStart`)。既に動いていればそれを引き継ぐので、
`scripts\start-jd2.cmd` で先に立ち上げてあっても構わない。LocalLauncher から回すなら `start.bat`。

1. 「ユーザー / 設定」からユーザーを作り、既定フォルダを絶対パスで登録する
2. URL を貼って「追加」。ジョブ単位で保存先を上書きすることもできる
3. 人間判定が要るジョブは「人間待ち」になり、Windows 通知で呼ばれる。実ブラウザでチェックを押せば残りは自動

### JD2 の起動まわりの設定 (`config.json` の `jd2`)

| キー | 既定 | 意味 |
|---|---|---|
| `autoStart` | `true` | API が応答しなければ PowerDowner が JD2 を起動する。落ちたら 15 秒周期で起こし直す |
| `headless` | `true` | GUI 無しで起動する。窓もトレイもクリップボード監視もバブル通知も出ない |
| `stopOnExit` | `true` | PowerDowner の終了時に JD2 も落とす (`autoStart` が `true` のときだけ) |
| `dir` / `javaExe` | `tools/jd2` / `tools/jre/bin/java.exe` | 置き場所 |
| `startTimeoutSec` | `240` | 起動待ちの上限。初回は自動アップデートで数分かかる |

`headless` の代償は **JD2 が CAPTCHA ダイアログを出せなくなること**だけ。PowerDowner は
それを検知して自前のブラウザ経路へ回すので、運用上は「リンクをコピーしても JD2 が
ポップアップしてこなくなる」効果の方が大きい。

手で起動・停止したいときは:

```bash
scripts\start-jd2-headless.cmd   # 画面には何も出ない
scripts\stop-jd2.cmd             # 窓もトレイも無いので、止めるにはこれを使う
```

CivitAI のログイン必須モデルは、設定画面で API キー (CivitAI のアカウント設定で発行) を保存しておくと落とせる。

## 構成

| パス | 役割 |
|---|---|
| `src/index.ts` | 起動。設定 → DB → エンジン → キュー復元 → HTTP |
| `src/queue.ts` | ジョブの状態機械。投入 / 再試行 / 中止 / 再起動後の復元 |
| `src/router.ts` | URL をどのエンジンに渡すか決める。HTML が返るページは JD2 へ |
| `src/volume.ts` | 作品名の正規化と巻数・範囲の解釈。同じ巻かどうかの判定はここに閉じる |
| `src/library.ts` | 取得済み台帳との突き合わせ。スキップ / 既存ジョブへの合流 / 新規を決める |
| `src/mirrors.ts` | 同じファイルの候補 URL を `mirrors.priority` の順に並べ替える |
| `src/inventory.ts` | 手元のファイル名から「もう持っている」を起こす。走査の対象は `library.scanDirs` |
| `src/resolvers/civitai.ts` | CivitAI の URL → 直リンク + SHA256 |
| `src/engines/aria2.ts` | aria2c の起動と JSON-RPC 制御 |
| `src/engines/jd2.ts` | JD2 Deprecated API クライアント。クロールジョブ ID → リンク UUID で追跡し、名前と保存先を `movetoNewPackage` で強制 |
| `src/engines/browser.ts` | Edge の起動、広告遮断、順番待ち、download イベントの横取りと aria2 への引き継ぎ |
| `src/drivers/xfs.ts` | XFileSharing 系サイトの自動操作。ブラウザ内で動かすコードは文字列で渡す (下記) |
| `src/favicon.ts` | ジョブ一覧に出すファビコンの取得とキャッシュ |
| `src/notify.ts` | Windows トースト通知 (人間の操作待ち)。将来 ntfy を足すのはここ |
| `src/server.ts` | REST + WebSocket + 静的ファイル。`GET /api/health` は死活監視用 |
| `public/` | UI (素の HTML/JS) |
| `scripts/` | ツール取得、JD2 の手動起動 / 停止 |
| `start.bat` | LocalLauncher からの起動口 |
| `docs/ROADMAP.md` | これから足す機能と、そのために壊してはいけない前提 |

## 運用メモ

- JD2 の初回起動は自動アップデートに 90 秒ほどかかる。`jd2.startTimeoutSec` (既定 240 秒) はそのための余裕
- JD2 の headless は `-Djava.awt.headless=true` だけで足りる。`Application.isHeadless()` が
  `GraphicsEnvironment.isHeadless()` を見ているので、GUI もトレイもクリップボード監視も丸ごと起動しなくなる
- headless の JD2 は起動時に `IllegalStateException: No Console Available!` を吐くが**正常**。
  画面も端末も無いので JD2 の対話コンソール UI が初期化できないだけで、API は問題なく動く。
  ログには意味の分かる 1 行に置き換えて出している (`JD2_BENIGN`)
- **Windows では PowerDowner に SIGTERM が届かない** (`taskkill /F` でしか落ちない)。つまり
  ランチャーに止められると終了処理が走らず、画面の無い JD2 が取り残される。対策は 2 つ入れてある:
  起動時に「応答しない JD2」を PID で片付ける (`killStale`) のと、既に動いている JD2 の引き継ぎ。
  ランチャー側にも `scripts\stop-jd2.cmd` を `stop_command` として登録しておくとより確実
- JD2 は起動するだけで 500 行近くログを吐く。`JD2_NOTEWORTHY` に当たる行だけを拾っている
- JD2 のローカル API は GET + URL エンコード JSON で呼ぶ。応答は `{"data": ...}` で包まれ、`status` 文字列は日本語ローカライズ済みなので判定には使わない
- PowerDowner を強制終了しても aria2c は生き残る。次回起動時に応答があればそのプロセスを引き継ぎ、進行中のダウンロードも続きから追跡する
- `.ps1` は UTF-8 BOM 付きで保存する。BOM 無しだと PowerShell 5.1 が日本語を CP932 として読んで構文エラーになる
- `page.evaluate()` に**関数を渡してはいけない**。tsx (esbuild) が keepNames の `__name` ヘルパーを埋め込み、
  ブラウザ側で `ReferenceError: __name is not defined` になる。ブラウザ内で動かすコードは文字列で渡す
- `form.id` は `<input name="id">` に影が差して要素を返す。id 属性が欲しいときは `getAttribute('id')` を使う
- `document.hidden` / `visibilityState` の偽装は**人間判定に嫌われる**。Cloudflare Turnstile が
  「Verification failed」で弾く。自前でカウントダウンを止めるサイト (uploady) だけに効かせること
  (`browser.keepAwakeHosts`)。他のサイトは Chromium の起動フラグだけで足りる
- hCaptcha は `recaptchacompat` モードだと `textarea[name="g-recaptcha-response"]` も作る。
  reCAPTCHA と誤認しないよう、hCaptcha の痕跡を先に見る
- **アップローダのドメインは 1 つではない**。ページ本体、アセット CDN、直リンクがそれぞれ別ドメインになる
  (frdl.io → frdl.hk、アセットは cdn.freedl.ink、直リンクは e21.urleecher.com)。
  「同一ドメインかどうか」で何かを判定すると必ず壊れる。ファイル名や拡張子など中身で判定すること
- Playwright の `route('**/*')` で全通信を横取りすると、それ自体が自動化の signature になり
  Cloudflare Turnstile が「Verification failed」で弾く。横取りは落としたい URL だけに絞る

## 自動操作できないサイト (katfile) — 手動リレー

katfile の Cloudflare Turnstile は **Playwright では通せない**。ページ読み込み時に
`console.log('%c%d', 'font-size:0;color:transparent', ...)` を全コンソールメソッドで実行する
デバッガ検出が走り、CDP 接続が露見する。CDP は Playwright の動作に必須なので設定では消せない。

放置している間は Turnstile はきれいなままで、チェックを押した瞬間に「Verification failed」になる。
自動操作をどれだけ目立たなくしても (可視状態の偽装を外す、通信の横取りをやめる、初期化スクリプトを
やめる、待ち受けを軽くする) 結果は変わらなかった。

**運用方法**: 普段のブラウザで katfile を開き、チェックとカウントダウンを済ませて最終ページまで進む。
ダウンロードボタンのリンクをコピーして PowerDowner に貼る。あとは aria2 が分割・再開付きで落とす。
ブラウザに直接落とさせるより、この方が「途切れない」という要件に合う。

## ジョブ一覧の見え方

行にはファイル名の下にホスト名 (`katfile.biz` など) とエンジンのチップ (aria2 / JD2 / ブラウザ) が出る。
ファビコンは `/api/favicon?host=` がサーバー側で取ってきて `data/favicons/` に貯める。
外部のファビコン API は使わない (どのアップローダを使っているかを他所に渡さないため)。
取れなかったサイトは頭文字のバッジ画像を生成して返すので、一覧に穴は空かない。

## 状態

`queued → resolving → downloading ⇄ waiting_human / waiting_site → done / failed / canceled`

- `waiting_human`: ブラウザで人間判定のチェックを待っている (GUI 起動の JD2 なら CAPTCHA 入力待ちも含む)。
  Windows 通知で呼ばれる。headless では JD2 発の人間待ちは起きず、全部ブラウザ経路に回る
- `waiting_site`: サイトの無料ダウンロード間隔にかかっている。時刻が来たら自動で再開する
- `failed` と `canceled` は「再試行」で `queued` に戻る
- ブラウザから引き継いだ直リンクを aria2 が拒否された場合、再試行するとブラウザ自身が保存する (`meta.browserDirect`)

## ブラウザ引き継ぎの流れ

人間の仕事は「人間判定のチェックを押す」だけ。それ以外はドライバ (`src/drivers/xfs.ts`) が進める。

1. Edge が専用プロファイル (`data/browser-profile`) で開く。表示言語は英語に固定 (文言解析を 1 言語に絞るため)
2. ドライバが Free Download ボタンを押し、サイトのカウントダウンを待ち、ダウンロードフォームを送信する。
   ボタンが `disabled` や非表示になっている間はカウントダウン中とみなして待つ。
   裏タブでもタイマーが進むよう `--disable-background-timer-throttling` 等を付けて起動する
3. Turnstile / reCAPTCHA / hCaptcha があれば、まず 8 秒は自動通過を待つ。通らなければ画面下のバナーが橙色になり、
   Windows 通知で人間を呼ぶ。チェックを押せば残りは自動で進む
4. ブラウザがファイルを落とし始めた瞬間に URL と Cookie を取り、ブラウザ側は止めて aria2 に渡す (単一接続)
5. 別サイトなら `browser.maxConcurrent` (既定 3) まで並行して進める。
   同じサイトは 1 件ずつ (無料枠は同時ダウンロードを弾かれるため)。待たされているジョブには理由を出す

偽ボタン対策として遮断するのは **広告配信網 (`AD_HOSTS`) と他所のドメインの iframe** だけ。別サイトのポップアップは自動で閉じる。
自動操作できないページは手動モードに落ち、HTML とスクリーンショットを `data/debug/` に残す。

当初は「同一サイト以外のサブリソースを全部遮断」していたが、これは**間違いだった**。アップローダは自前の JS を
別ドメインの CDN から配る (frdl.hk → cdn.freedl.ink)。それを止めるとボタンの `onclick` が未定義になり、
ページは表示されるのに何を押しても無反応になる。偽ボタンは他所の iframe に出るので、そこだけ塞げば足りる。

ページが動かないときは `POST /api/jobs/<id>/dump` を叩く。HTML とスクリーンショットを `data/debug/` に落とし、
**遮断した要求の一覧**を返す。原因は大抵ここに出る。

```bash
curl -s -X POST http://localhost:3939/api/jobs/<id>/dump
```

サイト側の「次のダウンロードまで N 分」制限を検出すると `waiting_site` になり、時刻が来たら自動で再開する。
待ち時刻は再起動をまたいでも保持される。

ページが 5xx を返した場合 (Cloudflare 522 など、サイトのオリジンが落ちている) も `waiting_site` にして
10 分後に自分で試し直す。人間を呼んでもどうにもならないため。6 回試して駄目なら失敗にする。
