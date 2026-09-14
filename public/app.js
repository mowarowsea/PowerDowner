/* PowerDowner UI - 依存なしの素の JS */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    users: [], jobs: new Map(), engines: {}, hosters: [], settings: {}, userId: null, showAll: false,
    // ミラー内訳を開いているジョブ。進捗で行を作り直しても開きっぱなしを保つ
    openMirrors: new Set(),
  };
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
  const ENGINE_LABEL = { aria2: 'aria2', jd2: 'JD2', browser: 'ブラウザ' };
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

  function saveUserPick() {
    try { localStorage.setItem('pd.userId', String(state.userId ?? '')); } catch { /* ignore */ }
  }
  function loadUserPick() {
    try { const v = localStorage.getItem('pd.userId'); return v ? Number(v) : null; } catch { return null; }
  }

  // ---- rendering ---------------------------------------------------------
  function renderEngines() {
    const el = $('engines');
    el.innerHTML = '';
    const LABEL = { aria2: 'aria2', jd2: 'JD2', browser: 'Browser' };
    for (const name of ['aria2', 'jd2', 'browser']) {
      const s = state.engines[name];
      const span = document.createElement('span');
      span.className = 'pill ' + (s && s.available ? 'on' : 'off');
      span.textContent = LABEL[name];
      span.title = s ? s.detail : '不明';
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
      const domains = (h.domains || []).join(', ');
      tr.innerHTML = `
        <td>
          <div class="hoster">
            <img class="fav" src="/api/favicon?host=${encodeURIComponent((h.domains || [])[0] || '')}" alt="" width="16" height="16">
            <div>
              <div class="name">${esc(h.label)}</div>
              <div class="hint small">${esc(domains)}</div>
            </div>
          </div>
        </td>
        <td class="num ok">${h.okCount}</td>
        <td class="num ${h.failCount > 0 ? 'bad' : ''}">${h.failCount}</td>
        <td class="num ${h.humanCount > 0 ? 'warnnum' : ''}">${h.humanCount}</td>
        <td class="nowrap" title="${esc(h.lastOkAt || '')}">${esc(fmtAgo(h.lastOkAt))}</td>
        <td class="mid"><input type="checkbox" data-act="use" ${h.enabled ? 'checked' : ''}></td>
        <td class="mid nowrap">
          <button type="button" class="ghost small" data-act="up" ${i === 0 ? 'disabled' : ''} title="先に試す">↑</button>
          <button type="button" class="ghost small" data-act="down" ${i === list.length - 1 ? 'disabled' : ''} title="後に回す">↓</button>
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
    sel.value = state.userId === null ? '' : String(state.userId);

    const body = $('usersBody');
    body.innerHTML = '';
    for (const u of state.users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="text" data-field="name" value="${esc(u.name)}"></td>
        <td><input type="text" data-field="defaultDir" value="${esc(u.defaultDir ?? '')}" placeholder="未設定 (投入時にエラーになります)"></td>
        <td><button type="button" class="small" data-act="save">保存</button> <button type="button" class="small ghost" data-act="del">削除</button></td>`;
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
    const list = visibleJobs();
    const root = $('jobs');
    $('jobsEmpty').hidden = list.length > 0;
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
    <span class="badge"></span>
    <img class="fav" alt="" width="20" height="20" loading="lazy">
    <div class="name">
      <div class="title"></div>
      <div class="sub"><span class="host"></span><span class="eng"></span><button type="button" class="mirbtn ghost" hidden></button><span class="rest"></span></div>
      <div class="human" hidden></div>
      <div class="err" hidden></div>
      <div class="bar"><i></i></div>
    </div>
    <div class="stat"></div>
    <div class="actions"></div>
    <div class="mirs" hidden>
      <div class="mirnote">同時に走るのは 1 か所だけです。上から順に試して、失敗したら次の候補へ移ります。</div>
      <ol class="mirlist"></ol>
    </div>`;

  function renderJob(el, job) {
    if (!el.__p) {
      el.innerHTML = JOB_HTML;
      el.__p = {
        badge: el.querySelector('.badge'), fav: el.querySelector('.fav'),
        title: el.querySelector('.title'), host: el.querySelector('.host'),
        eng: el.querySelector('.eng'), rest: el.querySelector('.rest'),
        human: el.querySelector('.human'), err: el.querySelector('.err'),
        bar: el.querySelector('.bar > i'), stat: el.querySelector('.stat'),
        actions: el.querySelector('.actions'),
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

    p.badge.className = `badge ${job.status}`;
    p.badge.textContent = STATUS_LABEL[job.status] || job.status;

    if (p.fav.dataset.host !== host) {
      p.fav.dataset.host = host;
      p.fav.src = `/api/favicon?host=${encodeURIComponent(host)}`;
      p.fav.title = host;
    }

    p.title.textContent = job.filename || job.url;
    p.title.title = job.url;

    p.host.textContent = host;
    p.eng.textContent = job.engine ? (ENGINE_LABEL[job.engine] || job.engine) : '';
    p.eng.className = 'eng' + (job.engine ? ` e-${job.engine}` : '');
    p.eng.hidden = !job.engine;

    const detail = (['downloading', 'waiting_human', 'waiting_site'].includes(job.status) && job.meta && job.meta.detail) ? job.meta.detail : '';

    p.rest.textContent = [detail, state.showAll ? userName(job.userId) : '', job.destDir].filter(Boolean).join(' · ');

    // 同じファイルの別サイト候補。DryEyes からの合流でも増えるので、何番目を試している
    // のかが見えないと「失敗したのに何故また動いているのか」が分からなくなる
    renderMirrors(p, job);

    const human = job.status === 'waiting_human' ? ((job.meta && job.meta.humanDetail) || '人間の操作が必要です') : '';
    p.human.textContent = human;
    p.human.hidden = !human;
    p.err.textContent = job.error || '';
    p.err.hidden = !job.error;

    const pct = job.bytesTotal > 0 ? Math.min(100, (job.bytesDone / job.bytesTotal) * 100) : (job.status === 'done' ? 100 : 0);
    p.bar.style.width = `${pct.toFixed(1)}%`;

    p.stat.innerHTML = job.status === 'downloading' || job.status === 'waiting_human'
      ? `${fmtBytes(job.bytesDone)} / ${job.bytesTotal ? fmtBytes(job.bytesTotal) : '?'}<br>${fmtBytes(job.speed)}/s`
      : job.status === 'done' ? fmtBytes(job.bytesTotal || job.bytesDone) : '';

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
    p.mirbtn.textContent = `候補 ${at}/${rows.length} ${open ? '▲' : '▼'}`;
    p.mirbtn.title = open ? 'アップローダごとの状況を閉じる' : 'アップローダごとの状況を見る';
    p.mirs.hidden = !open;
    if (!open) return;

    // 1 秒ごとの進捗更新で作り直すと選択が飛ぶので、中身が変わった時だけ書き換える
    const key = rows.map((r) => [r.url, r.kind, r.label, r.error, r.off].join('\t')).join('\n');
    if (p.mirlist.dataset.key === key) return;
    p.mirlist.dataset.key = key;

    p.mirlist.innerHTML = rows.map((r, i) => `
      <li class="mir s-${r.kind}">
        <span class="mnum">${i + 1}</span>
        <span class="mbadge">${esc(r.label)}</span>
        <span class="mhoster" title="${esc(r.host || '')}">${esc(r.hoster)}${r.off ? ' <span class="moff" title="台帳で「使用しない」にした業者です。既に候補に入っている分はこのまま試します">除外</span>' : ''}</span>
        <a class="murl" href="${esc(r.url)}" target="_blank" rel="noreferrer noopener" title="${esc(r.url)}">${esc(r.url.replace(/^https?:\/\//, ''))}</a>
        ${r.error ? `<span class="merr">${esc(r.error)}</span>` : ''}
      </li>`).join('');
  }

  function renderActions(root, job) {
    const acts = [];
    if (job.status === 'failed' || job.status === 'canceled') acts.push(['retry', '最初から再試行', 'このジョブの候補を全部やり直す。失敗の記録を消して、優先度の高いアップローダから試し直します']);
    if (job.status === 'waiting_human' && job.engine === 'jd2') acts.push(['resume', 'JD2 で再開', 'JD2 のスキップを解除して再挑戦させる']);
    if (['queued', 'resolving', 'downloading', 'waiting_human', 'waiting_site'].includes(job.status)) acts.push(['cancel', '中止', '']);
    acts.push(['remove', '×', '一覧から消す (ファイルは残ります)']);
    const key = acts.map((a) => a[0]).join(',');
    if (root.dataset.key === key) return; // ボタンの顔ぶれが同じなら作り直さない
    root.dataset.key = key;
    root.innerHTML = '';
    for (const [act, label, tip] of acts) {
      const b = document.createElement('button');
      b.className = act === 'remove' ? 'small ghost' : 'small';
      b.textContent = label;
      if (tip) b.title = tip;
      b.onclick = async () => {
        try {
          if (act === 'retry') await api('POST', `/api/jobs/${job.id}/retry`);
          else if (act === 'cancel') await api('POST', `/api/jobs/${job.id}/cancel`);
          else if (act === 'resume') await api('POST', `/api/jobs/${job.id}/resume`);
          else if (act === 'remove') await api('DELETE', `/api/jobs/${job.id}`);
        } catch (e) { alert(e.message); }
      };
      root.appendChild(b);
    }
  }

  function renderLog() {
    $('log').textContent = logLines.join('\n');
  }

  function renderAll() {
    renderEngines();
    renderUsers();
    renderJobs();
    if ($('hostersDialog').open) renderHosters();
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
    const b = $('captchaBanner');
    if (!n || n.pending === 0) { b.hidden = true; return; }
    b.textContent = `JD2 が CAPTCHA の入力を待っています (${n.hosts.join(', ')})。JD2 のウィンドウで解いてください。解けば自動で再開します。`;
    b.hidden = false;
  }

  // ---- events ------------------------------------------------------------
  $('userSelect').onchange = (e) => {
    state.userId = e.target.value ? Number(e.target.value) : null;
    saveUserPick();
    renderJobs();
  };
  $('showAll').onchange = (e) => { state.showAll = e.target.checked; renderJobs(); };
  $('btnUsers').onclick = () => { $('dialogError').hidden = true; $('usersDialog').showModal(); };
  $('btnHosters').onclick = () => {
    $('hostersDialog').showModal();
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

  $('btnAdd').onclick = async () => {
    const err = $('addError');
    err.hidden = true;
    const urls = $('urls').value;
    if (!urls.trim()) return;
    if (state.userId === null) { err.textContent = '先に「ユーザー / 設定」からユーザーを登録してください'; err.hidden = false; return; }
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
        $('workBox').open = true;  // 畳んだまま効き続けるのを防ぐ
        reportWork(r);
        return;
      }
      // 「使用しない」で弾いたものは、消えた理由が分からないと設定を疑えない
      for (const name of new Set((r.rejected || []).map((x) => x.hoster))) {
        toast(`${name} は使用しない設定です (「アップローダ」で変更できます)`, 'warn');
      }
      if (r.skipped && r.skipped.length) { err.textContent = `スキップ: ${r.skipped.join(', ')}`; err.hidden = false; }
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      $('btnAdd').disabled = false;
    }
  };
  $('urls').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') $('btnAdd').click();
  });
  $('btnClearDone').onclick = async () => {
    const done = visibleJobs().filter((j) => j.status === 'done');
    for (const j of done) { try { await api('DELETE', `/api/jobs/${j.id}`); } catch { /* ignore */ } }
  };

  // ---- boot --------------------------------------------------------------
  state.userId = loadUserPick();
  connect();
})();
