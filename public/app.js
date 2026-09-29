/* PowerDowner UI - 依存なしの素の JS */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    users: [], jobs: new Map(), engines: {}, hosters: [], settings: {}, userId: null, showAll: false,
    // ミラー内訳を開いているジョブ。進捗で行を作り直しても開きっぱなしを保つ
    openMirrors: new Set(),
    // 完了ジョブは既定で畳む
    showDone: false, showLog: false,
    // JD2 が知らせてきた CAPTCHA の待ち (要対応バナーの材料)
    captcha: null,
  };
  try {
    state.showDone = localStorage.getItem('pd.showDone') === '1';
    state.showLog = localStorage.getItem('pd.showLog') === '1';
  } catch { /* ignore */ }
  const LOG_MAX = 80;
  const logLines = [];

  // ---- helpers -----------------------------------------------------------
  const fmtBytes = (n) => {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
  };
  const STATUS_LABEL = {
    queued: '待機', resolving: '解決中', downloading: 'DL中', waiting_human: '人間待ち', waiting_site: 'サイト制限待ち',
    done: '完了', failed: '失敗', canceled: '中止',
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ENGINE_LABEL = { aria2: 'aria2', jd2: 'JD2', browser: 'Browser' };
  const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

  // ---- ミラー候補 --------------------------------------------------------

  /** サーバー側の hostMatches と同じ判定。frdl.io も cdn.frdl.io も frdl 業者 */
  const hostMatches = (host, domains) => domains.some((d) => host === d || host.endsWith('.' + d));

  /** この URL の業者。台帳に無ければ null (直リンクや CivitAI はここに来る) */
  function hosterOf(url) {
    const host = hostOf(url);
    if (!host) return null;
    return state.hosters.find((h) => (h.domains || []).length > 0 && hostMatches(host, h.domains)) || null;
  }

  /**
   * 1 ジョブのミラー候補を、試す順に並べて返す。
   *
   * ダウンロードは同時並行ではなく 1 か所ずつ。失敗して初めて次の候補へ移るので、
   * 「済んだもの (meta.tried) → 今の 1 件 (job.url) → 順番待ち (meta.mirrors)」を
   * つなぐと、そのままジョブの歩みになる。
   */
  function mirrorRundown(job) {
    const meta = job.meta || {};
    const tried = Array.isArray(meta.tried) ? meta.tried : [];
    const mirrors = Array.isArray(meta.mirrors) ? meta.mirrors : [];
    const rows = [];
    const seen = new Set();

    const push = (url, kind, label, error, current) => {
      const u = String(url || '');
      if (!u || seen.has(u)) return;
      seen.add(u);
      const h = hosterOf(u);
      rows.push({
        url: u, kind, label, error: error || '', current: !!current,
        host: hostOf(u),
        // 台帳に無い URL (直リンク・CivitAI) は業者名が無いのでホスト名で出す
        hoster: h ? h.label : hostOf(u),
        // 台帳から外した後も、既に候補に入っている分はそのまま試される。
        // 「切ったはずのところで待っている」が見えないと不審に見えるので出す
        off: !!(h && !h.enabled),
      });
    };

    for (const t of tried) push(t && t.url, 'failed', '失敗', t && t.error, false);
    const kind = job.status === 'done' ? 'done'
      : (job.status === 'failed' || job.status === 'canceled') ? 'failed'
      : 'active';
    push(job.url, kind, STATUS_LABEL[job.status] || job.status, job.error, true);
    for (const m of mirrors) push(m, 'pending', '順番待ち', '', false);

    return rows;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
    if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
    return data;
  }

  /** 画面の隅に短く出す。エラー欄と違って、次の操作を邪魔しない知らせに使う */
  function toast(text, kind = 'info') {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, kind === 'warn' ? 9000 : 5000);
  }

  /** 「3 日前」まで。それより古いものは日付で出す */
  function fmtAgo(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '—';
    const min = Math.floor((Date.now() - t) / 60000);
    if (min < 1) return 'たった今';
    if (min < 60) return `${min} 分前`;
    if (min < 60 * 24) return `${Math.floor(min / 60)} 時間前`;
    const days = Math.floor(min / (60 * 24));
    if (days <= 3) return `${days} 日前`;
    const d = new Date(t);
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  }

  // 「全員」は '*' で保存する。userId は直前の値を残す (見るだけで、投入先にはならない)
  function saveUserPick() {
    try { localStorage.setItem('pd.userId', state.showAll ? '*' : String(state.userId ?? '')); } catch { /* ignore */ }
  }
  function loadUserPick() {
    try {
      const v = localStorage.getItem('pd.userId');
      if (v === '*') { state.showAll = true; return null; }
      return v ? Number(v) : null;
    } catch { return null; }
  }

  // ---- rendering ---------------------------------------------------------
  /** 生きていれば点だけ。落ちた業者だけ名前を出す */
  function renderEngines() {
    const el = $('engines');
    el.innerHTML = '';
    for (const name of ['aria2', 'jd2', 'browser']) {
      const s = state.engines[name];
      const on = !!(s && s.available);
      const span = document.createElement('span');
      span.className = `eng-dot ${on ? 'on' : 'off'}`;
      if (!on) span.textContent = ENGINE_LABEL[name];
      span.title = `${ENGINE_LABEL[name]}: ${s ? s.detail : '不明'}`;
      el.appendChild(span);
    }
  }

  // ---- アップローダ ------------------------------------------------------

  async function hostersAction(fn) {
    const err = $('hostersError');
    err.hidden = true;
    try {
      const r = await fn();
      if (r && r.hosters) state.hosters = r.hosters;
      else state.hosters = (await api('GET', '/api/hosters')).hosters;
      renderHosters();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  function renderHosters() {
    const body = $('hostersBody');
    body.innerHTML = '';
    const list = state.hosters;

    // 全部外すと、何を投入しても無音で消える。気づけないので必ず言う
    const on = list.filter((h) => h.enabled).length;
    const warn = $('hostersWarn');
    if (list.length > 0 && on === 0) {
      warn.textContent = 'すべてのアップローダが「使用しない」です。この状態ではワンクリックホスターの URL は 1 件もジョブになりません (直リンクと CivitAI は落ちます)。';
      warn.hidden = false;
    } else {
      warn.hidden = true;
    }

    list.forEach((h, i) => {
      const tr = document.createElement('tr');
      if (!h.enabled) tr.className = 'off';
      const zero = (n) => (n > 0 ? '' : ' zero');
      tr.innerHTML = `
        <td title="${esc((h.domains || []).join(', '))}">
          <div class="hoster">
            <img class="fav" src="/api/favicon?host=${encodeURIComponent((h.domains || [])[0] || '')}" alt="" width="16" height="16">
            <span class="name">${esc(h.label)}</span>
          </div>
        </td>
        <td class="num${zero(h.okCount)}">${h.okCount}</td>
        <td class="num${h.failCount > 0 ? ' bad' : ' zero'}">${h.failCount}</td>
        <td class="num${zero(h.humanCount)}">${h.humanCount}</td>
        <td class="nowrap" title="${esc(h.lastOkAt || '')}">${esc(fmtAgo(h.lastOkAt))}</td>
        <td class="mid"><input type="checkbox" class="switch" data-act="use" ${h.enabled ? 'checked' : ''}></td>
        <td class="mid nowrap">
          <button type="button" class="quiet sm" data-act="up" ${i === 0 ? 'disabled' : ''} title="先に試す"><i class="fa-solid fa-arrow-up"></i></button>
          <button type="button" class="quiet sm" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} title="後に回す"><i class="fa-solid fa-arrow-down"></i></button>
        </td>`;
      tr.querySelector('[data-act=use]').onchange = (e) => hostersAction(
        () => api('PATCH', `/api/hosters/${encodeURIComponent(h.key)}`, { enabled: e.target.checked }),
      );
      tr.querySelector('[data-act=up]').onclick = () => hostersAction(
        () => api('POST', `/api/hosters/${encodeURIComponent(h.key)}/move`, { dir: 'up' }),
      );
      tr.querySelector('[data-act=down]').onclick = () => hostersAction(
        () => api('POST', `/api/hosters/${encodeURIComponent(h.key)}/move`, { dir: 'down' }),
      );
      body.appendChild(tr);
    });
  }

  function renderUsers() {
    const sel = $('userSelect');
    sel.innerHTML = '';
    if (state.users.length === 0) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(ユーザー未登録)';
      sel.appendChild(o);
    }
    for (const u of state.users) {
      const o = document.createElement('option');
      o.value = String(u.id);
      o.textContent = u.defaultDir ? u.name : `${u.name} (既定フォルダ未設定)`;
      sel.appendChild(o);
    }
    if (state.userId === null || !state.users.some((u) => u.id === state.userId)) {
      state.userId = state.users.length ? state.users[0].id : null;
      saveUserPick();
    }
    const all = document.createElement('option');
    all.value = '*'; all.textContent = '全員';
    sel.appendChild(all);
    sel.value = state.showAll ? '*' : (state.userId === null ? '' : String(state.userId));

    const body = $('usersBody');
    body.innerHTML = '';
    for (const u of state.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" data-field="name" value="${esc(u.name)}"></td>
        <td><input type="text" data-field="defaultDir" value="${esc(u.defaultDir ?? '')}" placeholder="未設定 (投入時にエラーになります)"></td>
        <td><button type="button" class="sm" data-act="save"><i class="fa-solid fa-check"></i> 保存</button> <button type="button" class="sm ghost" data-act="del"><i class="fa-solid fa-trash-can"></i> 削除</button></td>`;
      tr.querySelector('[data-act=save]').onclick = async () => {
        const name = tr.querySelector('[data-field=name]').value;
        const defaultDir = tr.querySelector('[data-field=defaultDir]').value;
        await dialogAction(() => api('PUT', `/api/users/${u.id}`, { name, defaultDir }));
      };
      tr.querySelector('[data-act=del]').onclick = async () => {
        if (!confirm(`ユーザー「${u.name}」を削除しますか？`)) return;
        await dialogAction(() => api('DELETE', `/api/users/${u.id}`));
      };
      body.appendChild(tr);
    }
    $('civitaiTokenState').textContent = state.settings.civitaiToken ? `設定済み (${state.settings.civitaiToken})` : '未設定';
    if (document.activeElement !== $('civitaiRoot')) $('civitaiRoot').value = state.settings.civitaiModelsRoot || '';
  }

  function visibleJobs() {
    const all = [...state.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    return state.showAll ? all : all.filter((j) => j.userId === state.userId);
  }

  function userName(id) {
    const u = state.users.find((x) => x.id === id);
    return u ? u.name : `#${id}`;
  }

  function renderJobs() {
    const all = visibleJobs();
    // 動いているものが埋もれないよう、完了は末尾へ回す (どちらも新しい順)
    const active = all.filter((j) => j.status !== 'done');
    const done = all.filter((j) => j.status === 'done');
    const list = state.showDone ? [...active, ...done] : active;
    const root = $('jobs');
    $('jobsEmpty').hidden = all.length > 0;
    renderNeed(all);
    $('jobCount').textContent = all.length ? String(all.length) : '';
    $('doneFoot').hidden = done.length === 0;
    $('doneCount').textContent = String(done.length);
    $('btnToggleDone').innerHTML = `<i class="fa-solid fa-chevron-${state.showDone ? 'down' : 'right'}"></i> ${state.showDone ? '隠す' : '表示'}`;
    const keep = new Set();
    for (const job of list) {
      keep.add(job.id);
      let el = root.querySelector(`[data-id="${job.id}"]`);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = job.id;
        root.appendChild(el);
      }
      renderJob(el, job);
    }
    for (const el of [...root.children]) {
      if (keep.has(el.dataset.id)) continue;
      state.openMirrors.delete(el.dataset.id);
      el.remove();
    }
    // 並び順を合わせる
    list.forEach((job, i) => {
      const el = root.querySelector(`[data-id="${job.id}"]`);
      if (root.children[i] !== el) root.insertBefore(el, root.children[i] || null);
    });
  }

  // 進捗更新は秒単位で飛んでくるので、行は一度組み立てて以後は中身だけ差し替える。
  // (毎回 innerHTML を書き直すとファビコンの img が作り直されてちらつく)
  const JOB_HTML = `
    <i class="stripe"></i>
    <img class="fav" alt="" width="18" height="18" loading="lazy">
    <div class="name">
      <div class="title"></div>
      <div class="sub">
        <span class="host"></span><span class="eng"></span><button type="button" class="mirbtn" hidden></button>
        <span class="rest"></span><span class="human" hidden></span><span class="err" hidden></span>
      </div>
    </div>
    <div class="stat"><div class="sz"></div><div class="st"></div></div>
    <div class="acts"></div>
    <div class="mirs" hidden><ol class="mirlist"></ol></div>
    <div class="bar"><i></i></div>`;

  function renderJob(el, job) {
    if (!el.__p) {
      el.innerHTML = JOB_HTML;
      el.__p = {
        fav: el.querySelector('.fav'),
        title: el.querySelector('.title'), host: el.querySelector('.host'),
        eng: el.querySelector('.eng'), rest: el.querySelector('.rest'),
        human: el.querySelector('.human'), err: el.querySelector('.err'),
        bar: el.querySelector('.bar > i'), sz: el.querySelector('.sz'), st: el.querySelector('.st'),
        actions: el.querySelector('.acts'),
        mirbtn: el.querySelector('.mirbtn'), mirs: el.querySelector('.mirs'),
        mirlist: el.querySelector('.mirlist'),
      };
      el.__p.mirbtn.onclick = () => {
        if (state.openMirrors.has(el.dataset.id)) state.openMirrors.delete(el.dataset.id);
        else state.openMirrors.add(el.dataset.id);
        const job = state.jobs.get(el.dataset.id);
        if (job) renderJob(el, job);
      };
    }
    const p = el.__p;
    const host = hostOf(job.url);
    el.className = `job ${job.status}`;

    if (p.fav.dataset.host !== host) {
      p.fav.dataset.host = host;
      p.fav.src = `/api/favicon?host=${encodeURIComponent(host)}`;
      p.fav.title = host;
    }

    // CivitAI は再試行でファイル名が消えても、何のモデルかはモデル名で分かるようにする
    const civ = job.meta && job.meta.civitai;
    p.title.textContent = job.filename || (civ ? `${civ.modelName} / ${civ.versionName}` : job.url);
    // 保存先は行に出さず、URL と一緒にここへ
    p.title.title = [job.url, job.destDir].filter(Boolean).join('\n');

    p.host.textContent = host;
    p.eng.textContent = job.engine ? (ENGINE_LABEL[job.engine] || job.engine) : '';
    p.eng.hidden = !job.engine;

    const detail = (['downloading', 'waiting_human', 'waiting_site'].includes(job.status) && job.meta && job.meta.detail) ? job.meta.detail : '';
    p.rest.textContent = [detail, civitNote(job), state.showAll ? userName(job.userId) : ''].filter(Boolean).join(' · ');
    p.rest.hidden = !p.rest.textContent;

    // 同じファイルの別サイト候補。DryEyes からの合流でも増えるので、何番目を試している
    // のかが見えないと「失敗したのに何故また動いているのか」が分からなくなる
    renderMirrors(p, job);

    const human = job.status === 'waiting_human' ? ((job.meta && job.meta.humanDetail) || '人間の操作が必要です') : '';
    p.human.textContent = human;
    p.human.hidden = !human;
    p.err.textContent = job.error || '';
    p.err.hidden = !job.error;

    const pct = job.bytesTotal > 0 ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100) : 0;
    p.bar.style.width = `${pct.toFixed(1)}%`;

    const running = job.status === 'downloading' || job.status === 'waiting_human';
    p.sz.textContent = running ? `${fmtBytes(job.bytesDone)} / ${job.bytesTotal ? fmtBytes(job.bytesTotal) : '?'}`
      : job.status === 'done' ? fmtBytes(job.bytesTotal || job.bytesDone) : '';
    p.st.textContent = job.status === 'downloading' ? `${fmtBytes(job.speed)}/s`
      : (STATUS_LABEL[job.status] || job.status);

    renderActions(p.actions, job);
  }

  /** ミラー候補の開閉ボタンと内訳。候補が 1 つしか無いジョブには何も出さない */
  function renderMirrors(p, job) {
    const rows = mirrorRundown(job);
    const at = rows.findIndex((r) => r.current) + 1;

    p.mirbtn.hidden = rows.length < 2;
    if (rows.length < 2) {
      p.mirs.hidden = true;
      return;
    }

    const open = state.openMirrors.has(job.id);
    p.mirbtn.innerHTML = `候補 ${at}/${rows.length} <i class="fa-solid fa-chevron-${open ? 'up' : 'down'}"></i>`;
    p.mirbtn.title = open ? 'アップローダごとの状況を閉じる' : 'アップローダごとの状況を見る';
    p.mirs.hidden = !open;
    if (!open) return;

    // 1 秒ごとの進捗更新で作り直すと選択が飛ぶので、中身が変わった時だけ書き換える
    const key = rows.map((r) => [r.url, r.kind, r.label, r.error, r.off].join('\t')).join('\n');
    if (p.mirlist.dataset.key === key) return;
    p.mirlist.dataset.key = key;

    p.mirlist.innerHTML = rows.map((r) => `
      <li class="mir s-${r.kind}">
        <span class="mark" title="${esc(r.label)}">${{ failed: '×', active: '●', done: '✓', pending: '·' }[r.kind]}</span>
        <span class="mhoster" title="${esc(r.host || '')}">${esc(r.hoster)}${r.off ? ' <span class="moff" title="台帳で「使用しない」にした業者です。既に候補に入っている分はこのまま試します">除外</span>' : ''}</span>
        <a class="murl" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener" title="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\//, ''))}</a>
        ${r.error ? `<span class="merr">${esc(r.error)}</span>` : ''}
      </li>`).join('');
  }

  const ACT_ICON = { retry: 'fa-rotate-right', resume: 'fa-play', preview: 'fa-image', cancel: 'fa-stop', remove: 'fa-xmark' };

  function renderActions(root, job) {
    const acts = [];
    if (job.status === 'failed' || job.status === 'canceled') acts.push(['retry', '再試行', 'このジョブの候補を全部やり直す。失敗の記録を消して、優先度の高いアップローダから試し直します']);
    if (job.status === 'waiting_human' && job.engine === 'jd2') acts.push(['resume', 'JD2 で再開', 'JD2 のスキップを解除して再挑戦させる']);
    const pv = job.meta && job.meta.preview;
    if (job.status === 'done' && pv && pv.state === 'failed') acts.push(['preview', '画像だけ取り直す', pv.error || '']);
    if (['queued', 'resolving', 'downloading', 'waiting_human', 'waiting_site'].includes(job.status)) acts.push(['cancel', '中止', '']);
    acts.push(['remove', '', '一覧から消す (ファイルは残ります)']);
    const key = acts.map((a) => a[0]).join(',');
    if (root.dataset.key === key) return; // ボタンの顔ぶれが同じなら作り直さない
    root.dataset.key = key;
    root.innerHTML = '';
    for (const [act, label, tip] of acts) {
      const b = document.createElement('button');
      b.className = act === 'remove' ? 'x' : 'sm';
      b.innerHTML = `<i class="fa-solid ${ACT_ICON[act]}"></i>${label ? ` ${esc(label)}` : ''}`;
      if (act === 'remove') b.setAttribute('aria-label', '一覧から消す');
      if (tip) b.title = tip;
      b.onclick = async () => {
        try {
          if (act === 'retry') await api('POST', `/api/jobs/${job.id}/retry`);
          else if (act === 'cancel') await api('POST', `/api/jobs/${job.id}/cancel`);
          else if (act === 'resume') await api('POST', `/api/jobs/${job.id}/resume`);
          else if (act === 'preview') await api('POST', `/api/jobs/${job.id}/preview`);
          else if (act === 'remove') await api('DELETE', `/api/jobs/${job.id}`);
        } catch (e) { toast(e.message, 'warn'); }
      };
      root.appendChild(b);
    }
  }

  function renderLog() {
    $('log').hidden = !state.showLog;
    $('btnLog').innerHTML = `<i class="fa-solid fa-terminal"></i> ${state.showLog ? 'ログを隠す' : 'ログを見る'}`;
    $('log').textContent = logLines.join('\n');
  }

  function renderAll() {
    renderEngines();
    renderUsers();
    renderJobs();
    if ($('settingsDialog').open) renderHosters();
  }

  function applyState(s) {
    state.users = s.users;
    state.jobs = new Map(s.jobs.map((j) => [j.id, j]));
    state.engines = Object.fromEntries(s.engines.map((e) => [e.name, e]));
    state.hosters = s.hosters || [];
    state.settings = s.settings;
    renderAll();
  }

  async function dialogAction(fn) {
    const err = $('dialogError');
    err.hidden = true;
    try {
      await fn();
      applyState(await api('GET', '/api/state'));
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  // ---- websocket ---------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'hello') applyState(m.state);
      else if (m.type === 'job') { state.jobs.set(m.job.id, m.job); renderJobs(); }
      else if (m.type === 'jobRemoved') { state.jobs.delete(m.id); renderJobs(); }
      else if (m.type === 'engine') { state.engines[m.status.name] = m.status; renderEngines(); }
      else if (m.type === 'captcha') showCaptcha(m.notice);
      // 自分が貼った分は POST の応答で出すので、ここは DryEyes からの投入だけ拾う
      else if (m.type === 'rejected' && m.notice.source === 'items') {
        const what = m.notice.label ? `「${m.notice.label}」` : '投入';
        toast(`${what}は登録しませんでした: ${m.notice.hosters.join(', ')} が使用しない設定です`, 'warn');
      }
      else if (m.type === 'log') { logLines.push(m.line); while (logLines.length > LOG_MAX) logLines.shift(); renderLog(); }
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }

  function showCaptcha(n) {
    state.captcha = n && n.pending > 0 ? n : null;
    renderNeed();
  }

  /**
   * 「人の手が要る」ものの受け口。JD2 の CAPTCHA と waiting_human のジョブを 1 か所に束ねる。
   * 数えるのは表示中のユーザーの分だけ (「全員」なら全部)
   */
  function renderNeed(list = visibleJobs()) {
    const b = $('captchaBanner');
    const lines = [];
    const n = state.captcha;
    if (n) {
      lines.push(`JD2 が CAPTCHA の入力を待っています (${esc(n.hosts.join(', '))})。 <small>JD2 のウィンドウで解いてください。解けば自動で再開します。</small>`);
    }
    const waiting = list.filter((j) => j.status === 'waiting_human');
    if (waiting.length === 1) {
      lines.push(`${esc(hostOf(waiting[0].url))} の人間判定を待っています。 <small>ブラウザのウィンドウで通してください。通れば自動で続きます。</small>`);
    } else if (waiting.length > 1) {
      lines.push(`${waiting.length} 件のジョブが人間の操作を待っています。 <small>ブラウザのウィンドウで通してください。通れば自動で続きます。</small>`);
    }
    b.hidden = lines.length === 0;
    b.innerHTML = lines.map((l) => `<div class="line"><span class="tag">要対応</span><span>${l}</span></div>`).join('');
  }

  // ---- CivitAI の確認カード ----------------------------------------------
  //
  // CivitAI の URL は貼った時点で下調べして、カードで「どのファイルを・どの画像と・どこへ」を
  // 決めてから投入する。保存先はモデルの根の下の実際のフォルダから選ぶ (アニメ / リアルなど、
  // 分け方は人それぞれなので固定の表を持たない)。

  const CIVIT_URL = /^https?:\/\/(?:www\.)?civitai\.(?:com|red)\//i;
  /** R (4) 以上を NSFW とみなす。CivitAI の段階は 1 PG / 2 PG-13 / 4 R / 8 X / 16 XXX */
  const NSFW_LEVEL = 4;
  const civit = { cards: [], seq: 0, hideNsfw: false };
  try { civit.hideNsfw = localStorage.getItem('pd.civitHideNsfw') === '1'; } catch { /* ignore */ }

  /** ジョブ行に出す補足。モデル名とバージョン、画像の状況 */
  function civitNote(job) {
    const c = job.meta && job.meta.civitai;
    if (!c) return '';
    const pv = job.meta.preview || {};
    const img = {
      pending: '画像: 待ち', saving: '画像: 保存中', ok: `画像: ${pv.file || '保存済み'}`,
      failed: `画像: 失敗 (${pv.error || ''})`, none: '画像なし',
    }[pv.state] || '';
    return [`${c.modelName} / ${c.versionName}`, img].filter(Boolean).join(' · ');
  }

  const civitVersion = (card) => card.data && card.data.info.versions.find((v) => v.id === card.versionId);
  const civitImages = (v) => (v ? v.images.filter((i) => !civit.hideNsfw || i.nsfwLevel < NSFW_LEVEL) : []);

  /** バージョンを選び直した時の初期値。ファイルは primary、画像は先頭、保存先は触っていなければ当たりへ */
  function civitSelectVersion(card, versionId) {
    card.versionId = versionId;
    const v = civitVersion(card);
    if (!v) return;
    const file = v.files.find((f) => f.primary) || v.files[0];
    card.fileId = file ? file.id : null;
    const imgs = civitImages(v);
    card.imageUrl = imgs.length ? imgs[0].url : null;
    if (!card.dirTouched) card.dir = card.data.suggested[versionId] || '';
  }

  /** 貼られた文字列から CivitAI の URL を抜いてカードにし、残りを返す */
  function takeCivitai(text) {
    const rest = [];
    for (const line of String(text).split(/\r?\n/)) {
      const other = [];
      for (const u of line.trim().split(/\s+/).filter(Boolean)) {
        if (CIVIT_URL.test(u)) addCivitCard(u);
        else other.push(u);
      }
      if (other.length) rest.push(other.join(' '));
    }
    return rest.join('\n');
  }

  async function addCivitCard(url) {
    if (civit.cards.some((c) => c.url === url)) return;
    const card = {
      id: ++civit.seq, url, loading: true, error: '', data: null,
      versionId: null, fileId: null, imageUrl: null, dir: '', dirTouched: false, custom: false, busy: false,
    };
    civit.cards.push(card);
    renderCivit();
    try {
      card.data = await api('GET', `/api/civitai/inspect?url=${encodeURIComponent(url)}`);
      civitSelectVersion(card, card.data.info.versionId);
    } catch (e) {
      card.error = e.message;
    } finally {
      card.loading = false;
      renderCivit();
      // 1 枚だけなら Enter でそのまま追加できるようにする
      if (civit.cards.length === 1) {
        const btn = $('civitCards').querySelector('[data-act=add]:not([disabled])');
        if (btn) btn.focus();
      }
    }
  }

  function removeCivitCard(card) {
    civit.cards = civit.cards.filter((c) => c !== card);
    renderCivit();
  }

  async function submitCivitCard(card) {
    if (card.busy || !card.data) return;
    card.error = '';
    if (state.showAll) card.error = 'ユーザーを選んでください';
    else if (state.userId === null) card.error = '先に「設定」からユーザーを登録してください';
    else if (!card.dir.trim()) card.error = '保存先を選んでください';
    if (card.error) { renderCivit(); return; }
    card.busy = true;
    renderCivit();
    try {
      await api('POST', '/api/civitai/jobs', {
        userId: state.userId, url: card.url, versionId: card.versionId, fileId: card.fileId,
        imageUrl: card.imageUrl, dir: card.dir,
      });
      toast(`追加しました: ${card.data.info.name}`);
      removeCivitCard(card);
    } catch (e) {
      card.error = e.message;
      card.busy = false;
      renderCivit();
    }
  }

  /** 保存先の表示用フルパス */
  function civitFullDir(card) {
    const d = card.data;
    const dir = card.dir.trim();
    if (!dir) return '';
    if (/^([a-z]:[\\/]|\\\\)/i.test(dir) || !d.root) return dir;
    return `${d.root.replace(/[\\/]+$/, '')}\\${dir}`;
  }

  function renderCivit() {
    $('civitBox').hidden = civit.cards.length === 0;
    $('btnCivitAll').hidden = civit.cards.filter((c) => c.data).length < 2;
    $('civitHideNsfw').checked = civit.hideNsfw;
    const root = $('civitCards');
    root.innerHTML = '';
    for (const card of civit.cards) root.appendChild(renderCivitCard(card));
  }

  function renderCivitCard(card) {
    const el = document.createElement('div');
    el.className = 'ccard';
    if (!card.data) {
      el.innerHTML = `
        <div class="ccthumb"><span>${card.loading ? '…' : '×'}</span></div>
        <div class="ccmain">
          <div class="cctitle">${card.loading ? '調べています…' : '読み込めませんでした'}</div>
          <div class="hint small">${esc(card.url)}</div>
          ${card.error ? `<div class="error">${esc(card.error)}</div>` : ''}
        </div>
        <div class="ccbtns"><button type="button" class="ghost small" data-act="close">やめる</button></div>`;
      el.querySelector('[data-act=close]').onclick = () => removeCivitCard(card);
      return el;
    }

    const d = card.data;
    const info = d.info;
    const v = civitVersion(card);
    const imgs = civitImages(v);
    const selected = v.images.find((i) => i.url === card.imageUrl);
    const file = v.files.find((f) => f.id === card.fileId);
    const exist = file ? (d.existing[file.name] || []) : [];
    const custom = card.custom || !d.root || (card.dir !== '' && !d.candidates.includes(card.dir));
    const stem = file ? file.name.replace(/\.[^.]+$/, '') : '';

    el.innerHTML = `
      <div class="ccthumb">${selected ? `<img src="${esc(selected.thumb)}" alt="" referrerpolicy="no-referrer">` : '<span>画像なし</span>'}</div>
      <div class="ccmain">
        <div class="cctitle">
          <a href="${esc(card.url)}" target="_blank" rel="noreferrer noopener">${esc(info.name)}</a>
          <span class="pill">${esc(info.type)}</span>
          ${v.baseModel ? `<span class="pill">${esc(v.baseModel)}</span>` : ''}
        </div>
        
        <div class="ccrow"><span class="cclabel">バージョン</span>
          <select data-f="version">${info.versions.map((x) => `<option value="${x.id}" ${x.id === card.versionId ? 'selected' : ''}>${esc(x.name)}${x.baseModel ? ` (${esc(x.baseModel)})` : ''}</option>`).join('')}</select>
          ${v.files.length === 1 && file ? `<span class="hint small">${fmtBytes(file.bytes)}</span>` : ''}
        </div>

        ${v.files.length > 1 ? `<div class="ccrow"><span class="cclabel">ファイル</span><div class="ccfiles">
          ${v.files.map((f) => `<label><input type="radio" name="cf${card.id}" value="${f.id}" ${f.id === card.fileId ? 'checked' : ''}> ${esc(f.name)} <span class="hint small">${fmtBytes(f.bytes)}${f.note ? ` · ${esc(f.note)}` : ''}</span></label>`).join('')}
        </div></div>` : ''}

        <div class="ccrow"><span class="cclabel">プレビュー</span><div class="ccimgs">
          ${imgs.map((i) => `<button type="button" class="ccimg ${i.url === card.imageUrl ? 'on' : ''}" data-img="${esc(i.url)}"><img src="${esc(i.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer"></button>`).join('')}
          <button type="button" class="ccimg none ${card.imageUrl ? '' : 'on'}" data-img="">なし</button>
          ${imgs.length < v.images.length ? `<span class="hint small">NSFW ${v.images.length - imgs.length} 枚を隠しています</span>` : ''}
        </div></div>

        <div class="ccrow"><span class="cclabel">保存先</span>
          ${d.root ? `<select data-f="dir">
              ${d.candidates.map((c) => `<option value="${esc(c)}" ${!custom && c === card.dir ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              <option value="__custom" ${custom ? 'selected' : ''}>その他 (パスを入力)…</option>
            </select>` : ''}
          ${custom ? `<input type="text" data-f="dirtext" value="${esc(card.dir)}" placeholder="${d.root ? 'モデルの根からの相対パス、または絶対パス' : '絶対パス (設定で「モデルの根」を入れると候補が出ます)'}">` : ''}
        </div>

        <div class="ccnames">
          <div class="ccdir">${esc(civitFullDir(card) || '(保存先が未選択)')}</div>
          ${file ? `<div>→ ${esc(file.name)}</div>` : ''}
          <div>→ ${card.imageUrl ? `${esc(stem)}.png <span class="hint small">(jpg の画像なら .jpg)</span>` : '<span class="hint small">画像は保存しない</span>'}</div>
        </div>
        ${exist.length ? `<div class="ccwarn"><i class="fa-solid fa-triangle-exclamation"></i> 同じ名前のファイルがもうあります: ${exist.map(esc).join(', ')}<br>このまま追加すると「 (2)」付きの別ファイルになります</div>` : ''}
        ${card.error ? `<div class="error">${esc(card.error)}</div>` : ''}
      </div>
      <div class="ccbtns">
        <button type="button" class="ghost small" data-act="close">やめる</button>
        <button type="button" class="primary" data-act="add" ${card.busy ? 'disabled' : ''}>${card.busy ? '追加中…' : '追加'}</button>
      </div>`;

    el.querySelector('[data-act=close]').onclick = () => removeCivitCard(card);
    el.querySelector('[data-act=add]').onclick = () => submitCivitCard(card);
    el.querySelector('[data-f=version]').onchange = (e) => { civitSelectVersion(card, Number(e.target.value)); renderCivit(); };
    for (const r of el.querySelectorAll(`input[name=cf${card.id}]`)) {
      r.onchange = () => { card.fileId = Number(r.value); renderCivit(); };
    }
    for (const b of el.querySelectorAll('[data-img]')) {
      b.onclick = () => { card.imageUrl = b.dataset.img || null; renderCivit(); };
    }
    const sel = el.querySelector('[data-f=dir]');
    if (sel) {
      sel.onchange = () => {
        card.dirTouched = true;
        card.custom = sel.value === '__custom';
        // 「その他」は今の値を種にして入力欄を出す。少し書き足すだけで済むように
        if (!card.custom) card.dir = sel.value;
        renderCivit();
        if (card.custom) {
          const t = document.querySelector(`[data-card="${card.id}"] [data-f=dirtext]`);
          if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
        }
      };
    }
    const txt = el.querySelector('[data-f=dirtext]');
    if (txt) {
      // 打つたびに描き直すと入力欄が作り直されて打てなくなるので、値と表示だけ差し替える
      txt.oninput = () => {
        card.dirTouched = true;
        card.dir = txt.value;
        el.querySelector('.ccdir').textContent = civitFullDir(card) || '(保存先が未選択)';
      };
      txt.onkeydown = (e) => { if (e.key === 'Enter') submitCivitCard(card); };
    }
    el.dataset.card = String(card.id);
    return el;
  }

  $('civitHideNsfw').onchange = (e) => {
    civit.hideNsfw = e.target.checked;
    try { localStorage.setItem('pd.civitHideNsfw', civit.hideNsfw ? '1' : '0'); } catch { /* ignore */ }
    // 選んでいた画像が隠れたら、見えている先頭に付け替える
    for (const card of civit.cards) {
      const imgs = civitImages(civitVersion(card));
      if (card.imageUrl && !imgs.some((i) => i.url === card.imageUrl)) card.imageUrl = imgs.length ? imgs[0].url : null;
    }
    renderCivit();
  };
  $('btnCivitAll').onclick = async () => {
    for (const card of [...civit.cards]) if (card.data) await submitCivitCard(card);
  };
  // 貼った瞬間にカードにする。「追加」を押してから調べ始めると、その数秒を余計に待つ
  $('urls').addEventListener('paste', () => {
    setTimeout(() => {
      const ta = $('urls');
      if (/civitai\.(com|red)\//i.test(ta.value)) ta.value = takeCivitai(ta.value);
    }, 0);
  });

  // ---- events ------------------------------------------------------------
  $('userSelect').onchange = (e) => {
    if (e.target.value === '*') state.showAll = true;
    else { state.showAll = false; state.userId = e.target.value ? Number(e.target.value) : null; }
    saveUserPick();
    renderJobs();
  };
  // ---- 設定ダイアログ (タブ 3 枚) ----
  function setTab(name) {
    for (const b of document.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const sec of document.querySelectorAll('[data-pane]')) sec.hidden = sec.dataset.pane !== name;
    try { localStorage.setItem('pd.settingsTab', name); } catch { /* ignore */ }
  }
  for (const b of document.querySelectorAll('[data-tab]')) b.onclick = () => setTab(b.dataset.tab);
  $('btnSettings').onclick = () => {
    let tab = 'hosters';
    try { tab = localStorage.getItem('pd.settingsTab') || tab; } catch { /* ignore */ }
    if (!document.querySelector(`[data-tab="${tab}"]`)) tab = 'hosters';
    setTab(tab);
    $('dialogError').hidden = true;
    $('settingsDialog').showModal();
    hostersAction(async () => null);
  };
  $('btnNewUser').onclick = () => dialogAction(async () => {
    await api('POST', '/api/users', { name: $('newUserName').value, defaultDir: $('newUserDir').value });
    $('newUserName').value = ''; $('newUserDir').value = '';
  });
  $('btnSaveToken').onclick = () => dialogAction(async () => {
    await api('PUT', '/api/settings', { civitaiToken: $('civitaiToken').value });
    $('civitaiToken').value = '';
  });
  $('btnSaveRoot').onclick = () => dialogAction(async () => {
    await api('PUT', '/api/settings', { civitaiModelsRoot: $('civitaiRoot').value });
  });
  /**
   * 作品として登録した時の結果。台帳で弾かれたもの・合流したものを黙って捨てると
   * 「登録したのに落ちてこない」の切り分けができなくなるので、必ず画面に出す。
   */
  function reportWork(r) {
    if (r.created && r.created.length) toast(`${r.created.length} 件を登録しました`);
    for (const m of r.merged || []) toast(`既にあるジョブへ候補として合流しました: ${m.title || ''}`);
    for (const s of r.skipped || []) toast(`台帳にあるので落としません: ${s.title || ''} (${s.reason})`, 'warn');
    for (const x of r.rejected || []) toast(`${x.title || ''}: ${x.reason}`, 'warn');
    const bad = (r.invalid || []).map((x) => x.reason);
    if (bad.length) { $('addError').textContent = bad.join('\n'); $('addError').hidden = false; }
  }

  function setWorkBox(open) {
    $('workBox').hidden = !open;
    $('btnWork').innerHTML = `<i class="fa-solid fa-${open ? 'minus' : 'plus'}"></i> 作品として登録`;
    if (!open) hideShelf();
  }
  $('btnWork').onclick = () => {
    setWorkBox($('workBox').hidden);
    if (!$('workBox').hidden) $('workTitle').focus();
  };

  $('btnAdd').onclick = async () => {
    const err = $('addError');
    err.hidden = true;
    // CivitAI の行はカードへ回す。残りだけをいつもの投入に流す
    const urls = takeCivitai($('urls').value);
    $('urls').value = urls;
    if (!urls.trim()) return;
    if (state.showAll) { err.textContent = 'ユーザーを選んでください'; err.hidden = false; return; }
    if (state.userId === null) { err.textContent = '先に「設定」からユーザーを登録してください'; err.hidden = false; return; }
    const title = $('workTitle').value.trim();
    $('btnAdd').disabled = true;
    try {
      const body = { userId: state.userId, urls, destDir: $('destDir').value || null };
      if (title) {
        body.item = {
          title,
          author: $('workAuthor').value.trim() || null,
          volume: $('workVolume').value.trim() || null,
        };
      }
      const r = await api('POST', '/api/jobs', body);
      $('urls').value = '';
      if (title) {
        // 作品名と著者は続けて使うので残す。巻数だけ消す — 残すと次の投入が同じ巻になり、
        // 台帳で弾かれて「なぜか落ちてこない」ことになる
        $('workVolume').value = '';
        setWorkBox(true);  // 畳んだまま効き続けるのを防ぐ
        reportWork(r);
        return;
      }
      // 「使用しない」で弾いたものは、消えた理由が分からないと設定を疑えない
      for (const name of new Set((r.rejected || []).map((x) => x.hoster))) {
        toast(`${name} は使用しない設定です (「設定」で変更できます)`, 'warn');
      }
      if (r.skipped && r.skipped.length) { err.textContent = `スキップ: ${r.skipped.join(', ')}`; err.hidden = false; }
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      $('btnAdd').disabled = false;
    }
  };
  // ---- 作品名・著者の候補 (棚 = pinax) -----------------------------------
  // 手で書くと棚と 1 文字違うだけで別フォルダに割れ、所持の判定も外れる。
  // 打った語で棚を引き、既にある綴りを選べるようにする。
  // **巻数は表示だけで欄には入れない** — ここを使うのは大抵、棚に無い巻を落とす時なので、
  // 棚の巻数を入れても邪魔になるだけ。
  const shelf = { hits: [], active: -1, seq: 0, timer: 0 };

  function hideShelf() {
    $('shelfHits').hidden = true;
    shelf.active = -1;
  }

  function renderShelf() {
    const ul = $('shelfHits');
    const title = $('workTitle').value.trim();
    const author = $('workAuthor').value.trim();
    ul.innerHTML = shelf.hits.map((h, i) => {
      const chosen = h.title === title && (h.author || '') === author;
      return `<li role="option" data-i="${i}" class="${i === shelf.active ? 'active' : ''}">
        <div class="t"><b>${esc(h.title)}</b>${chosen ? '<span>選択中</span>' : ''}<span>${h.files}冊</span></div>
        <span class="s">${esc(h.author || '著者なし')}${h.shelf ? ` · <span class="gap">${esc(h.shelf)}</span>` : ''}</span>
      </li>`;
    }).join('');
    ul.hidden = shelf.hits.length === 0;
  }

  function pickShelf(i) {
    const h = shelf.hits[i];
    if (!h) return;
    $('workTitle').value = h.title;
    $('workAuthor').value = h.author || '';
    hideShelf();
    $('workVolume').focus();
  }

  function searchShelf(q) {
    clearTimeout(shelf.timer);
    const note = $('shelfNote');
    if (!q.trim()) { shelf.hits = []; hideShelf(); note.hidden = true; return; }
    // 打つたびに投げないよう少し待つ。遅れて返ってきた古い答えは捨てる
    shelf.timer = setTimeout(async () => {
      const seq = ++shelf.seq;
      try {
        const r = await api('GET', `/api/pinax/series?q=${encodeURIComponent(q.trim())}`);
        if (seq !== shelf.seq) return;
        shelf.hits = r.items || [];
        shelf.active = -1;
        renderShelf();
        note.hidden = true;
      } catch (e) {
        if (seq !== shelf.seq) return;
        // 棚が止まっていても手入力で登録できる。邪魔しない濃さで理由だけ出す
        shelf.hits = [];
        hideShelf();
        note.textContent = e.message;
        note.hidden = false;
      }
    }, 250);
  }

  for (const id of ['workTitle', 'workAuthor']) {
    const input = $(id);
    input.addEventListener('input', () => searchShelf(input.value));
    input.addEventListener('focus', () => { if (shelf.hits.length) renderShelf(); });
    input.addEventListener('blur', () => setTimeout(hideShelf, 150));
    input.addEventListener('keydown', (e) => {
      if ($('shelfHits').hidden) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        // -1 (どれも選んでいない) を挟んで一周する
        const n = shelf.hits.length;
        let a = shelf.active + (e.key === 'ArrowDown' ? 1 : -1);
        if (a >= n) a = -1;
        if (a < -1) a = n - 1;
        shelf.active = a;
        renderShelf();
      } else if (e.key === 'Enter' && shelf.active >= 0) {
        e.preventDefault();
        pickShelf(shelf.active);
      } else if (e.key === 'Escape') {
        hideShelf();
      }
    });
  }
  // mousedown で拾う — click だと先に blur で一覧が閉じて押せない
  $('shelfHits').addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-i]');
    if (!li) return;
    e.preventDefault();
    pickShelf(Number(li.dataset.i));
  });

  $('urls').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('btnAdd').click();
  });
  $('btnLog').onclick = () => {
    state.showLog = !state.showLog;
    try { localStorage.setItem('pd.showLog', state.showLog ? '1' : '0'); } catch { /* ignore */ }
    renderLog();
  };
  $('btnToggleDone').onclick = () => {
    state.showDone = !state.showDone;
    try { localStorage.setItem('pd.showDone', state.showDone ? '1' : '0'); } catch { /* ignore */ }
    renderJobs();
  };
  $('btnClearDone').onclick = async () => {
    const done = visibleJobs().filter((j) => j.status === 'done');
    for (const j of done) { try { await api('DELETE', `/api/jobs/${j.id}`); } catch { /* ignore */ } }
  };

  // ---- boot --------------------------------------------------------------
  state.userId = loadUserPick();
  renderLog();
  connect();
})();
