/* PowerDowner UI - 依存なしの素の JS */
(() => {
  const $ = (id) => document.getElementById(id);
  const state = { users: [], jobs: new Map(), engines: {}, settings: {}, userId: null, showAll: false };
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
    for (const el of [...root.children]) if (!keep.has(el.dataset.id)) el.remove();
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
      <div class="sub"><span class="host"></span><span class="eng"></span><span class="rest"></span></div>
      <div class="human" hidden></div>
      <div class="err" hidden></div>
      <div class="bar"><i></i></div>
    </div>
    <div class="stat"></div>
    <div class="actions"></div>`;

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

    // 同じファイルの別サイト候補。DryEyes からの合流でも増えるので、残数が見えないと
    // 「失敗したのに何故また動いているのか」「何を試して駄目だったのか」が分からなくなる
    const mirrors = (job.meta && Array.isArray(job.meta.mirrors)) ? job.meta.mirrors : [];
    const tried = (job.meta && Array.isArray(job.meta.tried)) ? job.meta.tried : [];
    const notes = [
      mirrors.length ? `ミラー残り ${mirrors.length}` : '',
      tried.length ? `${tried.length} 件試行済み` : '',
    ];
    p.rest.textContent = [detail, ...notes, state.showAll ? userName(job.userId) : '', job.destDir].filter(Boolean).join(' · ');
    p.rest.title = tried.length
      ? tried.map((t) => `${t.url}\n  → ${t.error || '失敗'}`).join('\n')
      : '';

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

  function renderActions(root, job) {
    const acts = [];
    if (job.status === 'failed' || job.status === 'canceled') acts.push(['retry', '再試行', '']);
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
  }

  function applyState(s) {
    state.users = s.users;
    state.jobs = new Map(s.jobs.map((j) => [j.id, j]));
    state.engines = Object.fromEntries(s.engines.map((e) => [e.name, e]));
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
  $('btnNewUser').onclick = () => dialogAction(async () => {
    await api('POST', '/api/users', { name: $('newUserName').value, defaultDir: $('newUserDir').value });
    $('newUserName').value = ''; $('newUserDir').value = '';
  });
  $('btnSaveToken').onclick = () => dialogAction(async () => {
    await api('PUT', '/api/settings', { civitaiToken: $('civitaiToken').value });
    $('civitaiToken').value = '';
  });
  $('btnAdd').onclick = async () => {
    const err = $('addError');
    err.hidden = true;
    const urls = $('urls').value;
    if (!urls.trim()) return;
    if (state.userId === null) { err.textContent = '先に「ユーザー / 設定」からユーザーを登録してください'; err.hidden = false; return; }
    $('btnAdd').disabled = true;
    try {
      const r = await api('POST', '/api/jobs', { userId: state.userId, urls, destDir: $('destDir').value || null });
      $('urls').value = '';
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
