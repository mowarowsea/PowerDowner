# PowerDowner UI 改装 設計書

`public/index.html` / `public/style.css` / `public/app.js` を対象にした見た目の改装。
**バックエンド (API・WebSocket・DB・エンジン) は触らない。** 画面から呼ぶ API は全部いまのまま使う。

この文書は実装担当 (別セッション) が単独で読んで作業できるように書いてある。
迷ったら「情報を減らす」「色を減らす」「説明文を画面から出す」の 3 つに寄せる。

---

## 0. 触らないもの

| もの | 理由 |
|---|---|
| `public/favicon.svg` と PNG 群、`<meta name="theme-color">` | アイコンは今のままで確定。ヘッダ左上にもこの SVG をそのまま出す |
| 「PowerDowner」の表記 | 大文字化・字間を開ける・別フォントで飾る、をしない。本文フォントの 600 で置くだけ |
| `src/` 以下 | 例外は §4 の Font Awesome を配信する 1 行だけ |
| ジョブの status とラベル (`STATUS_LABEL`) | 文言は現状維持。変えるのは色の当て方 |
| API の呼び方・WS メッセージの扱い | `app.js` の `api()`、`connect()`、`applyState()` は流用 |

---

## 1. 診断 (何がダサいのか)

1. **README を分割して画面に貼ってある。** 投入欄の hint 段落 4 行、ダイアログの説明段落、候補一覧の毎回出る注意書き。初回に 1 度読めば済む文章が常時場所を取っている。
2. **色が多すぎる。** `--accent / --ok / --wait / --bad / --human` の 5 色を、8 種類の status ごとにバッジ・バー・ピルへ全部当てている。「見てほしい状態」と「どうでもいい状態」が同じ強さで光る。
3. **カードの中にカードがある。** 角丸カードのジョブ行を角丸カードの中に積み、さらに候補内訳も角丸の箱。境界線だらけで平坦。
4. **完了が積み上がる。** 完了ジョブが進行中と同じ大きさで並ぶので、動いているものが埋もれる。
5. **姉妹アプリ pinax と顔が違う。** pinax は暖色の紙・影のあるパネル・意味色の使い分けで整っている。PowerDowner は Tailwind 既定値の灰色。

---

## 2. 方針

- **pinax の姉妹として揃える。** 暖色の紙、白いパネルに薄い影、`--line` の細い罫線。ブランド色だけ pinax の赤に対して琥珀 (今の `#c9820e` 系)。
- **色は琥珀 1 本 + 意味色 3 つ。** 進行中 = 琥珀、要対応 = 紫、失敗 = 赤、完了 = 緑 (文字だけ)。待機・サイト制限待ち・中止は無彩色。
- **ジョブは「1 枚のリスト」。** 行を罫線で区切る。状態は左端 4px の帯、進捗は行の下辺 2px。
- **説明文は README へ。** 画面に残す文章は 1 行以内、しかも `title` 属性か placeholder で済むなら文にしない。
- **完了は畳む。** 既定で非表示、末尾の 1 行に件数と「表示 / 消す」。
- **アイコンは Font Awesome。** ボタンの文字を減らす。

---

## 3. デザイントークン

`style.css` の先頭を以下に置き換える。**コンポーネントの色は必ずこのトークン経由**で、直書きの色を残さない。

```css
/* pinax と同じ暖色の紙の上に、白いパネルを影で浮かせる。色は琥珀 1 本 + 意味色 3 つ */
:root {
  /* 背景。彩度は判断保留 (§9)。切り替えは下の 1 行だけ */
  --bg: #f6f3ee;            /* 彩度高め案: #f4efe6 */
  --panel: #fffdf9;         /* カード・ヘッダ・ダイアログ */
  --panel-2: #f1ece3;       /* 畳んだ完了行・ファビコンの下地など、パネルの中の一段暗い面 */
  --line: #e6dfd3;
  --ink: #221d17;
  --ink-2: #6b6259;         /* 補助文字 */
  --ink-3: #9b9187;         /* さらに薄い文字、placeholder、ヒント */
  --amber: #b4740a;         /* アクセント (進行中・主ボタン) */
  --amber-ink: #ffffff;     /* 琥珀の上の文字 */
  --amber-soft: #f6e9cf;
  --need: #6d4aa8;          /* 要対応 (人間の手が要る)。pinax の --care と同じ値 */
  --need-soft: #eee8f7;
  --bad: #b8392a;
  --bad-soft: #f7e6e2;
  --ok: #3f7d58;            /* 完了。文字にしか使わない */
  --focus: #8a8075;         /* フォーカス。琥珀は明度が高くて浮くので使わない */
  --shadow: 0 1px 2px rgba(40,30,15,.06), 0 6px 18px rgba(40,30,15,.07);
  --radius: 12px;
  --sans: "Hiragino Sans", "Yu Gothic UI", "Meiryo", system-ui, sans-serif;   /* pinax と同じ */
  --mono: "Cascadia Mono", Consolas, ui-monospace, monospace;                  /* Windows 11 標準。Web フォント不要 */
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #15120e;          /* 彩度高め案: #181309 */
    --panel: #1d1914;
    --panel-2: #262119;
    --line: #322b23;
    --ink: #ece5db;
    --ink-2: #b3a999;
    --ink-3: #7f766c;
    --amber: #e2a53a;
    --amber-ink: #1c1405;
    --amber-soft: #3a2b12;
    --need: #ad8ee0;
    --need-soft: #2b2338;
    --bad: #e06a5a;
    --bad-soft: #3a1f1b;
    --ok: #6cae87;
    --focus: #8f857a;
    --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 18px rgba(0,0,0,.35);
  }
}
```

今の `--accent / --wait / --human / --bar / --card / --muted / --border / --text` は全部消して、上の名前に置き換える。

### 3.1 フォーカス

琥珀のリングは明度が高くて目立ちすぎる。**色付きリングをやめる。**

```css
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--focus); }
.add:focus-within { border-color: var(--focus); }          /* 投入欄は textarea が枠なしなのでカード側の枠を変える */
button:focus-visible, a:focus-visible, [tabindex]:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
```

`box-shadow` の光彩は付けない。

### 3.2 タイポグラフィ

| 用途 | 指定 |
|---|---|
| 本文 | `14px/1.55 var(--sans)` |
| 見出し (h2) | `13px 600 var(--ink-2)`、字間 `.02em`。大きくしない。セクション名は目立つ必要がない |
| ワードマーク | `16px 600 var(--ink)`、本文フォント。**「PowerDowner」の綴りそのまま** |
| 数値 (バイト数・速度・件数・実績) | `var(--mono)` + `font-variant-numeric: tabular-nums` |
| URL・エンジン名・経路 | `var(--mono)` 11〜12px |

---

## 4. Font Awesome

`@fortawesome/fontawesome-free` を npm 依存に足し、`node_modules` から直接配信する (ファイルをリポジトリにコピーしない)。

```ts
// src/server.ts — 既存の fastifyStatic 登録の直後に 1 行
await app.register(fastifyStatic, {
  root: path.join(ROOT, 'node_modules/@fortawesome/fontawesome-free'),
  prefix: '/vendor/fa/', decorateReply: false,
});
```

```html
<link rel="stylesheet" href="/vendor/fa/css/all.min.css">
```

使うアイコン (solid、`fa-solid`):

| 場所 | アイコン | 備考 |
|---|---|---|
| ヘッダ「設定」 | `fa-gear` | 文字「設定」も残す |
| ジョブ「中止」 | `fa-stop` | 文字も残す |
| ジョブ「再試行」 | `fa-rotate-right` | 文字も残す |
| ジョブ「JD2 で再開」 | `fa-play` | 文字も残す |
| ジョブ「画像だけ取り直す」 | `fa-image` | 文字も残す |
| ジョブ「一覧から消す」 | `fa-xmark` | **アイコンのみ**、`title` で説明 |
| 候補の開閉 | `fa-chevron-down` / `fa-chevron-up` | 「候補 2/4」の後ろ |
| 要対応バナー | `fa-hand` | |
| 完了行の畳み | `fa-chevron-right` / `fa-chevron-down` | |
| アップローダ優先度 ↑↓ | `fa-arrow-up` / `fa-arrow-down` | API は今の `/move` をそのまま使う。ドラッグ並べ替えはしない |
| ユーザー行「保存」「削除」 | `fa-check` / `fa-trash-can` | |
| ログを見る | `fa-terminal` | |
| 作品として登録 (開閉) | `fa-plus` / `fa-minus` | |

エンジンの状態 (§5.1) はアイコンではなく点。

---

## 5. 画面構成

幅は `max-width: 960px` で中央寄せ (今は 1100)。左右余白 16px。`main` 内の縦の間隔は `gap: 14px`。

### 5.1 ヘッダ

`position: sticky`、背景 `--panel`、下罫線 `--line`。中身は左から:

1. **ワードマーク**: `<img src="/favicon.svg" width="24" height="24">` + `PowerDowner` (§3.2)。`margin-right: auto`。
2. **エンジン状態**: 3 つの点 (8px 丸)。生きていれば `--ok`、落ちていれば `--bad` にして**その時だけ名前を横に出す** (`aria2` / `JD2` / `Browser`、`--mono` 11px)。全部生きている時は点 3 つだけで文字なし。今の 3 ピル常時表示はやめる。`title` に `detail` を入れるのは今のまま。
3. **ユーザー選択** `<select id="userSelect">`。「ユーザー」のラベル文字は消す。**末尾に「全員」の option を足す** (value `*`)。これで `#showAll` のチェックボックスを廃止する (§7.1)。
4. **設定ボタン** 1 つ (`fa-gear` + 「設定」)。「アップローダ」「ユーザー / 設定」の 2 ボタンを統合 (§5.6)。

640px 以下ではエンジンの点を隠す。

### 5.2 要対応バナー

`#captchaBanner` を「人の手が要る」ものすべての受け口にする。出す条件:

- JD2 の CAPTCHA 通知 (`m.type === 'captcha'`、今のまま)
- `waiting_human` のジョブが 1 件以上ある (表示中ユーザーの分。「全員」なら全部)

文言は 1 行 + 補足を薄く。例:

> **要対応** katfile の人間判定を待っています。 <small>ブラウザのウィンドウで通してください。通れば自動で続きます。</small>

複数あれば件数で束ねる (「2 件のジョブが人間の操作を待っています」)。左に `--need` 枠の小さな「要対応」札 (`--mono` 11px 600)。背景 `--need-soft`、枠 `--need` の 40%。
**画面で紫を使うのはここと `waiting_human` の行だけ。**

### 5.3 投入

白いパネル (`--panel`、`--shadow`、`--radius`) 1 枚。中身:

```
┌──────────────────────────────────────────────┐
│ URL を貼る (複数行 OK)                          │  ← textarea。枠なし、mono 13px、min-height 64px
│                                                │
├──────────────────────────────────────────────┤  ← --line
│ [+ 作品として登録]            Ctrl+Enter [追加] │  ← 操作列
└──────────────────────────────────────────────┘
```

- textarea の placeholder は「URL を貼る (複数行 OK)」だけ。例 URL は消す。
- **「作品として登録」は開閉ボタン**にして、開くと textarea と操作列の間に 1 段挿入:
  `作品名` / `著者` / `巻数` / `保存先 (空欄なら既定)` の 4 つの input を横並び (`flex-wrap`)。
  `#destDir` はこの段に移す (常時露出をやめる)。
- **説明文は全部消す。** `.work .hint` の段落、`#shelfNote` の「棚に見当たりません…」、巻数の挙動の説明も出さない。挙動は README に書いてある。
  `#shelfNote` のうち **pinax に繋がらない時のエラー**だけは残す (薄い文字 1 行)。
- 棚の候補ドロップダウン (`#shelfHits`) は今の挙動のまま。見た目はパネルと同じ枠・影に揃える。
- 「追加」は `.btn.primary` (琥珀)。左の `Ctrl+Enter` は `--mono` 11px `--ink-3`。
- `#addError` は操作列の下に赤文字で。今のまま。

### 5.4 ジョブ一覧

見出し行 (`h2` 「ジョブ」 + 件数 `--mono`) の下に**パネル 1 枚** (`--panel`、`--line` 枠、`--radius`、影なし)。中に行を積む。

#### 行のグリッド

```
grid-template-columns: 4px 22px minmax(0,1fr) auto auto;
gap: 0 12px; padding: 10px 12px 10px 0; border-top: 1px solid var(--line); position: relative;
```

| 列 | 中身 |
|---|---|
| 1 | 状態の帯 `.stripe` (`align-self: stretch`)。色は下表 |
| 2 | ファビコン 18px (`/api/favicon` のまま)。角丸 4px、下地 `--panel-2` |
| 3 | `.title` (600、1 行省略) と `.sub` (12px `--ink-2`、横並び `gap: 8px`) |
| 4 | `.stat` 右寄せ `--mono` 12px。上段: バイト数、下段 `.st`: 状態ラベルか速度 |
| 5 | `.acts` ボタン列 |

`.sub` に入れるもの (この順、空なら省く):

1. ホスト名 (`--ink`)
2. エンジン `.eng` (`--mono` 10.5px、`--line` の枠、`--ink-3`)。**色分けしない** (今の `e-aria2 / e-jd2 / e-browser` の色は廃止)
3. 候補ボタン「候補 2/4 ▾」(候補が 2 つ以上ある時だけ。`--amber` 文字、枠なし)
4. `meta.detail` (downloading / waiting_site / waiting_human の時)
5. CivitAI の補足 `civitNote()` (モデル名 / バージョン、画像の状況)
6. ユーザー名 (「全員」表示の時だけ)
7. `waiting_human` の `humanDetail` → `--need` 文字
8. `job.error` → `--bad` 文字

**`destDir` は `.sub` に出さない。** `.title` の `title` 属性に URL と一緒に入れる。

#### 状態と色

| status | 帯 | 下辺バー | `.st` の文字 | 既定で表示 |
|---|---|---|---|---|
| `queued` | なし | なし | 待機 (`--ink-3`) | ○ |
| `resolving` | `--amber` | なし | 解決中 | ○ |
| `downloading` | `--amber` | `--amber` | 速度 (`4.2 MB/s`) | ○ |
| `waiting_site` | なし | なし | サイト制限待ち (`--ink-3`) | ○ |
| `waiting_human` | `--need` | `--need` (進んでいれば) | 人間待ち (`--need`) | ○ |
| `failed` | `--bad` | なし | 失敗 (`--bad`) | ○ |
| `canceled` | なし | なし | 中止 (`--ink-3`) | ○ |
| `done` | なし | なし | 完了 (`--ok`)、上段にサイズ | **× (畳む)** |

- 今の `.badge` (96px の丸札列) は廃止。状態は帯 + `.st` だけ。
- 下辺バーは `position: absolute; left:0; right:0; bottom:0; height: 2px`。今の 6px のバーは廃止。
- `done` の行はファビコンとタイトルを `opacity: .7`。

#### 候補の内訳 (`.mirs`)

行の下に `grid-column: 2 / -1` で展開。**箱にしない** (枠・背景なし)。`--mono` 12px、`--ink-3`。
**`.mirnote` の注意書き「同時に走るのは 1 か所だけです…」は削除。**

1 行 = `記号 / 業者名 / URL (省略) / エラー (次行)`。記号: 失敗 `×` (`--bad`)、今 `●` (`--amber`、業者名と URL も琥珀)、順番待ち `·`。
「除外」の印は今のまま `--bad` の文字で。

#### 操作ボタン

`renderActions()` の中身と順序はそのまま。見た目だけ:

- `retry / resume / preview / cancel` → `.btn.sm` にアイコン + 文字
- `remove` → `fa-xmark` のみ、枠なし、`--ink-3`、hover で `--ink`
- `alert(e.message)` はトーストに変える (`toast(e.message, 'warn')`)

#### 完了を畳む

- 既定で `done` は描かない。パネル末尾に 1 行 `.donefoot` (背景 `--panel-2`):
  `完了 12 件` + 右端に「表示」「一覧から消す」(`.btn.quiet.sm`)。
- 「表示」で `done` を末尾に展開 (トグル、`localStorage` の `pd.showDone` に保存)。
- 「一覧から消す」= 今の `#btnClearDone` の処理。**上の見出し行のボタンは廃止。**
- 完了が 0 件なら `.donefoot` を出さない。
- 並び: `done` 以外を `createdAt` 降順 → その後に `done` を `createdAt` 降順。

#### 空の状態

`#jobsEmpty` の文言を「ジョブはありません」だけにする。今の「上の欄に URL を貼って…」は消す。

### 5.5 CivitAI の確認カード

構造は今のまま。変えるのは:

- 「タグ: …」の行を削除。
- `.civithead` の説明「モデルと、同じ名前のプレビュー画像を…」を削除。「NSFW の画像を候補から外す」は残す。
- `.ccard` の枠を `--amber` から `--line` にし、`--shadow` を付ける (投入パネルと同格)。
- `.ccnames` の保存先表示: 背景を `--panel-2`、`--mono` 12px。「→」の 2 行はそのまま。
- `.ccimg.on` の枠は `--amber` のまま (選択中の 1 枚だけ琥珀)。
- `.ccwarn` (同名ファイルあり) は `--bad` ではなく `--ink-2` の文字 + `fa-triangle-exclamation`。上書きはしないので警告色は要らない。

### 5.6 設定 (ダイアログ 1 つ、タブ 3 枚)

`#usersDialog` と `#hostersDialog` を **`#settingsDialog` 1 つ**にまとめ、上部にタブ「アップローダ / ユーザー / CivitAI」。
幅 `min(860px, 96vw)`。タブは文字のみ、選択中は下線 `--amber` 2px + 600。

`dialogAction()` と `hostersAction()` のエラー欄はそれぞれのタブ内に置く (今の `#dialogError` / `#hostersError` を残してよい)。

#### アップローダ タブ

上下の説明段落を削除し、表の下に 1 行だけ: 「上から順に試す。切った業者は DryEyes から来てもジョブにならない。」(`--ink-3` 12px)

表の列:

| 列 | 内容 | 備考 |
|---|---|---|
| アップローダ | ファビコン 16px + 名前 (600) | **ドメイン列挙は消す**。`title` 属性に入れる |
| 経路 | `JD2` / `BROWSER` / `ARIA2` | `--mono` 10.5px の枠札。`config.browser.hosts` に載っていれば BROWSER、それ以外は JD2。今の `/api/hosters` に経路が無ければ **この列は省略**して構わない (API は触らない) |
| 成功 / 失敗 / 人間待ち | `--mono` 右寄せ | 成功: `--ink-2`。失敗: 1 以上で `--bad`。**人間待ち: 常に `--ink-2`** (下記) |
| 最後の成功 | `fmtAgo()` のまま | |
| 使用する | トグル風チェック (§5.6.1) | |
| 優先度 | `fa-arrow-up` / `fa-arrow-down` の `.btn.quiet.sm` | 先頭・末尾で disabled は今のまま |

**「人間待ち」は「過去に人間の手が要った回数」で、その業者が手のかかる業者かどうかを見る実績値。** 「今なにか待っている」という警告ではないので `--need` を当てない。0 は `--ink-3`、1 以上は `--ink-2`。ヘッダの `title` 説明は今のまま。

「使用しない」の行は文字を `--ink-3` にし、名前の 600 を外す。`opacity: .45` は廃止 (チェックまで薄くなるのを避ける)。

全部外した時の `#hostersWarn` は残す (背景 `--bad-soft`)。

##### 5.6.1 トグル

```css
.switch { appearance: none; width: 30px; height: 18px; border-radius: 999px; background: var(--line); position: relative; cursor: pointer; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--panel); box-shadow: 0 1px 2px rgba(0,0,0,.25); transition: left .15s; }
.switch:checked { background: var(--amber); }
.switch:checked::after { left: 14px; }
```

#### ユーザー タブ

説明段落「ユーザーはデータの切り分け用です…」を削除。表はそのまま。「既定フォルダ」入力の placeholder を `D:\Downloads\name (絶対パス)` にして説明を兼ねる。
保存 / 削除は `fa-check` / `fa-trash-can` のアイコン + 文字。削除の `confirm()` は今のまま。

#### CivitAI タブ

説明段落 2 つを削除。

- API キー: placeholder 「API キー (空欄で保存すると削除)」、横に `#civitaiTokenState`。
- モデルの根: placeholder 「例: C:\SD\models (StableDiffusion / Lora が並ぶフォルダ)」。

### 5.7 ログ

`<footer class="log">` の常時表示をやめる。`main` の末尾右寄せに `fa-terminal` 「ログを見る」(`--ink-3` 12px、枠なし)。押すと `<pre id="log">` を展開 (トグル、`localStorage` の `pd.showLog`)。中身と `LOG_MAX` は今のまま。

### 5.8 通知の整理

| 種類 | 出口 |
|---|---|
| 人の手が要る (CAPTCHA、`waiting_human`) | §5.2 のバナー |
| 投入結果 (登録した / 合流 / 棚にあるので落とさない / 使用しない) | トースト (今のまま) |
| 投入の入力エラー (`invalid`) | `#addError` |
| ジョブ単位のエラー | 行内 `.sub` の赤文字 |
| ボタン操作の失敗 | トースト (`alert` を置き換え) |

トーストの見た目: `--panel` 背景、`--line` 枠、`--shadow`。`warn` は枠を `--need` にせず **`--bad-soft` 背景 + `--bad` 枠**にする (紫は「人の手が要る」専用)。

---

## 6. 削除・移動 一覧

| 要素 | 場所 | 処置 |
|---|---|---|
| 台帳の CSS (`#itemsDialog` 〜 `.badge.i-pending`、`.ledger .series .shead .sedit .lrows .lrow .lacts`) | `style.css` | **削除**。commit `c8e7d93` で台帳を捨てた残骸。html / js に参照なし |
| `.work .hint` の段落 | `index.html` | 削除 |
| `#shelfNote` の「棚に見当たりません…」 | `app.js` `searchShelf()` | 削除。接続エラー時の文言だけ残す |
| `.mirnote` | `app.js` `JOB_HTML` / `style.css` | 削除 |
| `#jobsEmpty` の後半 | `index.html` | 「ジョブはありません」に短縮 |
| `#showAll` チェックボックス | `index.html` / `app.js` | 削除。`userSelect` の「全員」に置換 (§7.1) |
| `#btnClearDone` (見出し行) | `index.html` / `app.js` | `.donefoot` へ移動 |
| `#btnHosters` / `#btnUsers` | `index.html` / `app.js` | `#btnSettings` 1 つに統合 |
| `#usersDialog` / `#hostersDialog` | `index.html` | `#settingsDialog` + タブに統合 |
| `.userpick > span` 「ユーザー」 | `index.html` | 削除 |
| `.engines` の 3 ピル | `app.js` `renderEngines()` | 点 3 つに置換 (§5.1) |
| `.badge` 列 | `JOB_HTML` / `style.css` | 削除。帯 + `.st` に置換 |
| `.eng.e-aria2 / e-jd2 / e-browser` の色 | `style.css` | 削除 (無彩色 1 種) |
| `.sub` の `destDir` | `app.js` `renderJob()` | `.title` の `title` 属性へ |
| CivitAI カードの「タグ:」行 | `app.js` `renderCivitCard()` | 削除 |
| `.civithead` の説明文 | `index.html` | 削除 |
| ダイアログ内の説明段落 (ユーザー / CivitAI / アップローダ上下) | `index.html` | 削除。placeholder と 1 行ヒントに置換 |
| アップローダ表のドメイン列挙 | `app.js` `renderHosters()` | `title` 属性へ |
| `<footer class="log">` 常時表示 | `index.html` | トグルに (§5.7) |
| `ENGINE_LABEL` と `renderEngines()` 内の `LABEL` | `app.js` | 1 つにまとめる |
| `alert(e.message)` | `app.js` `renderActions()` | `toast(e.message, 'warn')` |
| README の「ユーザー / 設定」「アップローダ」ボタン名への言及 | `README.md` | 「設定」に合わせて直す |

---

## 7. JS の変更点 (挙動)

### 7.1 ユーザー選択の「全員」

- `renderUsers()` で option を足す: `value="*"`、文字「全員」。
- `state.showAll` は残し、`userSelect.onchange` で `value === '*'` なら `showAll = true, userId = 直前の値を保持`、それ以外は `showAll = false, userId = Number(value)`。
- `saveUserPick()` は `'*'` も保存できるようにする。
- 投入時 (`btnAdd`、CivitAI カード) に `showAll` なら **「全員」のままでは投入できない**旨を `#addError` に出す (「ユーザーを選んでください」)。

### 7.2 完了の畳み

- `state.showDone` (既定 false、`localStorage` `pd.showDone`)。
- `visibleJobs()` は変えず、`renderJobs()` で `done` を分ける。`.donefoot` は `#jobs` の直後に静的に置き、件数と表示状態を `renderJobs()` で更新。

### 7.3 要対応バナー

- `showCaptcha(n)` の内容と `waiting_human` のジョブ数を合成する `renderNeed()` を作り、`renderJobs()` と `captcha` 受信の両方から呼ぶ。
- 表示中ユーザーの `waiting_human` のみ数える (`visibleJobs()` を使う)。

### 7.4 設定ダイアログ

- タブは `data-tab` 属性のボタンと `data-pane` の `<section>` で切り替え。開いた時は前回のタブ (`localStorage` `pd.settingsTab`)。
- 開く時に `hostersAction(async () => null)` を呼ぶのは今のまま (アップローダ表の更新)。

### 7.5 変えないもの

`mirrorRundown()`、`renderMirrors()` の差分更新、`renderJob()` の「行は一度組み立てて中身だけ差し替える」方式、CivitAI カードの状態管理、棚の候補 (`searchShelf` 一式)、WS の再接続。

---

## 8. 実装順序

1 つの PR に全部入れず、この順で分ける。**各ステップで見た目が壊れない**ようにする。

1. **文章と死骸を消す** — §6 のうち html の説明文削除、台帳 CSS 削除、`LABEL` 重複解消。挙動変更なし。
2. **トークン差し替え** — §3 の `:root` に置き換え、旧トークン名を全部置換。フォーカス (§3.1)。まだ構造は今のまま。
3. **Font Awesome** — §4。ボタンにアイコンを足す。
4. **ジョブ行** — §5.4 のグリッド・帯・下辺バー・候補内訳・完了の畳み・空の状態。
5. **ヘッダと投入** — §5.1 (点、全員、設定ボタン)、§5.3 (開閉、`destDir` 移動)。
6. **設定ダイアログ統合** — §5.6。
7. **バナー統合とログのトグル** — §5.2、§5.7、§5.8。
8. **CivitAI カード** — §5.5。

### 受け入れチェック

- ライト / ダーク両方で、直書きの色が残っていない (`grep -E '#[0-9a-f]{3,6}' public/style.css` がトークン定義以外に出ない)。
- 640px 幅で横スクロールが出ない。行の操作列が折り返す。
- 進行中 3 件 + 完了 20 件の状態で、初期表示に完了が出ない。「表示」で末尾に出る。
- `waiting_human` の行があるとバナーが出る。全部進むと消える。
- エンジンが全部生きている時、ヘッダに文字が無い。1 つ落ちると名前が出る。
- 「全員」を選んだまま「追加」を押すとエラー文が出て投入されない。
- `npm test` が通る (フロントは対象外だが、`server.ts` の 1 行追加で壊れないこと)。

---

## 9. 未決 (もわの判断待ち)

| 項目 | 現状の指定 | 代替 |
|---|---|---|
| 背景の彩度 | `--bg: #f6f3ee` / dark `#15120e` | `#f4efe6` / `#181309`。トークン 1 行の差なので、実装後に見比べて決める。**両方の値をコメントで残す** |
| ワードマークのフォント | 本文フォント 600 | 飾らない。変えたくなったらトークン `--wordmark` を足す |
| 「経路」列 | `/api/hosters` に経路が無ければ省略 | API に足すなら別 PR |

---

## 付録: 参考モック

もわが見た確認用のモックは https://claude.ai/artifact/ShbbCbeorMa53GmDbnX2wC (非公開リンク)。
**モックと本書が食い違う所は本書が正。** 特にモックのワードマーク (等幅・大文字) とアイコン (自作の矢印) は不採用。
