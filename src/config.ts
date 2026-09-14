import fs from 'node:fs';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /**
   * DryEyes などプログラムからの投入 (POST /api/jobs の items 形式) を守る共有トークン。
   * host は 0.0.0.0 なので、これが無いと LAN 内の誰でも任意 URL を落とさせられる。
   * 空にすると検証しない (起動時に警告を出す)。
   */
  apiToken: string;
  aria2: {
    exe: string;
    rpcPort: number;
    secret: string;
    maxConcurrent: number;
    splits: number;
  };
  jd2: {
    apiUrl: string;
    hosts: string[];
    /** API が応答しなければ PowerDowner が JD2 を起動し、終了時に落とす */
    autoStart: boolean;
    /**
     * GUI 無しで起動する。クリップボード監視・トレイ・バブル通知が動かなくなる代わりに、
     * CAPTCHA ダイアログを出す先も無くなるので、人間待ちは全部ブラウザ経路へ回る。
     */
    headless: boolean;
    dir: string;              // JDownloader.jar の置き場所
    javaExe: string;          // JD2 を動かす java。相対パスは PowerDowner のルート基準
    startTimeoutSec: number;  // 起動待ちの上限。初回は自動アップデートで数分かかる
    stopOnExit: boolean;      // PowerDowner の終了時に JD2 も落とす (autoStart 時のみ)
  };
  /**
   * 蔵書カタログ pinax。「この巻もう持ってる?」の答えはここだけが知っている。
   *
   * PowerDowner は取得済みの台帳を持たない (docs/ROADMAP.md 2.5)。聞けない時は
   * 「持っていない」に倒して落とすので、ここが未設定でも停止中でも投入は通る。
   */
  pinax: {
    /** 空にすると聞きに行かない (= 判定なしで全部落とす) */
    baseUrl: string;
    /** pinax の config.json の apiToken と同じ値。向こうが空なら不要 */
    token: string;
    /**
     * 応答を待つ上限。**短くしすぎないこと** — ここで諦めると持っている巻を
     * もう一度落とす。棚は SQLite なので普段は数十 ms で返る。
     */
    timeoutMs: number;
  };
  /**
   * 完了時のリネームとフォルダ分け。形式は固定で、テンプレートは設けない —
   * 自由に書けるようにすると棚 (pinax) が読み戻せない名前を人間が書けてしまい、
   * 手元にあるのに「持っていない」と判断して二重に落とす (src/naming.ts)。
   */
  rename: {
    /** false なら落ちてきた名前のまま置く */
    enabled: boolean;
    /** 作品ごとに 「[著者] 作品名」 フォルダを掘る */
    folder: boolean;
  };
  mirrors: {
    /**
     * 同じファイルが複数のアップローダに置かれている時に、どこから試すかの並び。
     * 前にあるものほど先に試す。ここに無いホストは末尾に回る。
     * 初期値は README の「ホスター別の実績」がそのまま元になっている。
     */
    priority: string[];
    /**
     * 今のアップローダが「同時ダウンロード数の上限」「待ってから」と言ってきた時に、
     * 別のアップローダへ移すまでの待ち時間 (秒)。
     *
     * 0 にすると即座に移す。すぐ移さないのは、上限は数分で空くことがあり、
     * 実績のあるホストを毎回手放すと落ちにくいほうへ流れてしまうため。
     */
    hostLimitWaitSec: number;
  };
  browser: {
    executablePath: string;   // 空なら Edge / Chrome の既定パスを探す
    profileDir: string;       // ログイン状態などを保持する専用プロファイル
    hosts: string[];          // 最初からブラウザ引き継ぎに回すドメイン
    timeoutMinutes: number;   // 人間の操作を待つ上限
    maxConcurrent: number;    // 同時に開くタブ数。同じサイトは常に 1 件ずつ、別サイトなら並行
    /**
     * 裏タブでカウントダウンが止まるサイト。ここに書いたドメインだけ「常に表示中」を偽装する。
     * 人間判定に嫌われるので全サイトには効かせない。
     */
    keepAwakeHosts: string[];
    /**
     * 広告が操作を邪魔するサイト。ここに書いたドメインでだけ強い広告対策を効かせる:
     * 他所への `window.open` を潰し、それでも開いたタブは行き先が分かった瞬間に閉じ、
     * 広告ドメインへ飛ばされたら元のページへ戻す。
     *
     * 全サイトに効かせないのは keepAwakeHosts と同じ理由 —
     * ページ読み込み前のスクリプト差し込みは自動化の痕跡になり、Cloudflare Turnstile に嫌われる。
     * 人間判定が厳しいサイト (katfile, rapidgator) には**入れないこと**。
     */
    adGuardHosts: string[];
    /**
     * 遮断する広告配信網の追加ドメイン (既定のリストに足される)。
     * 新しい配信網に当たったら `/api/jobs/:id/dump` の「遮断」欄と data/debug の HTML を見て足す。
     */
    adHosts: string[];
  };
}

const DEFAULTS: Config = {
  port: 3939,
  host: '0.0.0.0',
  dataDir: 'data',
  apiToken: '',
  aria2: {
    exe: 'tools/aria2/aria2c.exe',
    rpcPort: 6800,
    secret: 'powerdowner',
    maxConcurrent: 3,
    splits: 8,
  },
  jd2: {
    apiUrl: 'http://127.0.0.1:3128',
    hosts: [],
    autoStart: true,
    headless: true,
    dir: 'tools/jd2',
    javaExe: 'tools/jre/bin/java.exe',
    startTimeoutSec: 240,
    stopOnExit: true,
  },
  pinax: {
    baseUrl: 'http://127.0.0.1:3838',
    token: '',
    timeoutMs: 5000,
  },
  rename: {
    enabled: true,
    folder: true,
  },
  mirrors: {
    hostLimitWaitSec: 60,
    priority: [
      'dailyuploads.net',
      'mexa.sh', 'mexashare.com',
      'wupfile.com',
      'uploady.io',
      'turbobit.net', 'turb.cc', 'turb.to',
      'frdl.to', 'frdl.io', 'frdl.my', 'frdl.hk',
      // Turnstile が描画されないので人間でも押すものが無い。katfile と同じ扱い
      'rapidgator.net', 'rg.to',
      'katfile.com', 'katfile.biz',
    ],
  },
  browser: {
    executablePath: '',
    profileDir: 'data/browser-profile',
    hosts: [],
    timeoutMinutes: 20,
    maxConcurrent: 3,
    keepAwakeHosts: ['uploady.io'],
    // Turnstile を出さないサイトなので強い広告対策を入れてよい
    adGuardHosts: ['dailyuploads.net'],
    adHosts: [],
  },
};

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

export function loadConfig(): Config {
  const file = path.join(ROOT, 'config.json');
  let user: Partial<Config> = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    const example = path.join(ROOT, 'config.example.json');
    if (fs.existsSync(example)) {
      user = JSON.parse(fs.readFileSync(example, 'utf8'));
      console.warn('[config] config.json が無いので config.example.json を使用します');
    }
  }
  const cfg: Config = {
    ...DEFAULTS,
    ...user,
    aria2: { ...DEFAULTS.aria2, ...(user.aria2 ?? {}) },
    jd2: { ...DEFAULTS.jd2, ...(user.jd2 ?? {}) },
    pinax: { ...DEFAULTS.pinax, ...(user.pinax ?? {}) },
    rename: { ...DEFAULTS.rename, ...(user.rename ?? {}) },
    mirrors: { ...DEFAULTS.mirrors, ...(user.mirrors ?? {}) },
    browser: { ...DEFAULTS.browser, ...(user.browser ?? {}) },
  };
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.aria2.exe = path.resolve(ROOT, cfg.aria2.exe);
  cfg.jd2.dir = path.resolve(ROOT, cfg.jd2.dir);
  cfg.jd2.javaExe = path.resolve(ROOT, cfg.jd2.javaExe);
  cfg.browser.profileDir = path.resolve(ROOT, cfg.browser.profileDir);
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  return cfg;
}
