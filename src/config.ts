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
  library: {
    /**
     * 「もう持っている」を台帳に起こすためにスキャンしてよいフォルダ。
     * ここに列挙したパスだけが対象になる (LAN に開いているので任意パスは読ませない)。
     *
     * 既定が空なのは、**保存先のフォルダ構成をまだ決めていない**ため。
     * 決めたらここに書く。決まるまでスキャンは無効のままで構わない
     * (手動の範囲登録だけでも台帳は使える)。
     */
    scanDirs: string[];
    /** サブフォルダまで辿るか。作品ごとにフォルダを掘る構成にするなら true */
    scanRecursive: boolean;
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
  library: {
    scanDirs: [],
    scanRecursive: false,
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
    library: { ...DEFAULTS.library, ...(user.library ?? {}) },
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
