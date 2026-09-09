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

  // ---- 台帳 --------------------------------------------------------------
  // 台帳は「持っている」と言い切る場所なので、間違った行が 1 つあるだけで、その巻は
  // 投入されても二度と落ちてこない。直すのも消すのもここで完結させる。
  // ジョブ一覧と違って勝手に動かないので、開いた時と操作した後にだけ読み直す。
  const ledger = { items: [], filter: '', onlyBad: false };
  const ITEM_STATUS = { have: '所持', done: '取得済', pending: 'DL中' };

  const volLabel = (r) =>
    r.volumeFrom === null ? '巻数不明'
    : r.volumeFrom === r.volumeTo ? `第${r.volumeFrom}巻`
    : `第${r.volumeFrom}-${r.volumeTo}巻`;
  const volValue = (r) =>
    r.volumeFrom === null ? '' : r.volumeFrom === r.volumeTo ? String(r.volumeFrom) : `${r.volumeFrom}-${r.volumeTo}`;

  async function loadLedger() {
    if (state.userId === null) { ledger.items = []; renderLedger(); return; }
    ledger.items = (await api('GET', `/api/items?userId=${state.userId}&limit=2000`)).items;
    renderLedger();
  }

  // 操作 → 読み直し。台帳を直すと他の行の警告 (重複や合流先) まで変わるので、
  // 手元で継ぎ足さずサーバーの見立てごと入れ替える
  async function ledgerAction(fn) {
    const err = $('itemsError');
    err.hidden = true;
    try {
      await fn();
      await loadLedger();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      try { await loadLedger(); } catch { /* 表示済みのメッセージを上書きしない */ }
    }
  }

  function ledgerGroups() {
    const q = ledger.filter.trim().toLowerCase();
    const map = new Map();
    for (const it of ledger.items) {
      let g = map.get(it.seriesKey);
      if (!g) { g = { key: it.seriesKey, rows: [] }; map.set(it.seriesKey, g); }
      g.rows.push(it);
    }
    const groups = [];
    for (const g of map.values()) {
      // 群の代表名は一番短い非空のタイトル。同じキーでも「作品名 第3巻」と「作品名 4-8巻」が
      // 混ざるので、巻数の付いた長いほうを避けるための当て推量
      const titles = g.rows.map((r) => (r.title || '').trim()).filter(Boolean).sort((a, b) => a.length - b.length);
      g.title = titles[0] || '';
      g.author = (g.rows.find((r) => r.author) || {}).author || '';
      g.warnings = g.rows.reduce((n, r) => n + r.warnings.length, 0);
      if (ledger.onlyBad && g.warnings === 0) continue;
      if (q) {
        const hay = [g.title, g.author, g.key, ...g.rows.map((r) =>
          [r.rawText, r.source, r.job && r.job.filename].filter(Boolean).join(' '))].join(' ').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      g.rows.sort((a, b) => (a.volumeFrom ?? -1) - (b.volumeFrom ?? -1) || a.id - b.id);
      groups.push(g);
    }
    groups.sort((a, b) => (a.title || a.key).localeCompare(b.title || b.key, 'ja'));
    return groups;
  }

  function renderLedger() {
    const groups = ledgerGroups();
    const bad = ledger.items.filter((r) => r.warnings.length > 0).length;
    const u = state.users.find((x) => x.id === state.userId);

    $('itemsOwner').textContent = u ? `— ${u.name}` : '— (ユーザー未選択)';
    $('itemsSummary').textContent = `${ledger.items.length} 件` + (bad ? ` / 要確認 ${bad} 件` : '');

    const empty = $('itemsEmpty');
    empty.hidden = groups.length > 0;
    empty.textContent =
      state.userId === null ? 'ユーザーを選んでください。'
      : ledger.items.length === 0 ? '台帳は空です。ダウンロードが完走すると自動で積まれます。'
      : '絞り込みに合う行がありません。';

    const root = $('itemsList');
    root.innerHTML = '';
    for (const g of groups) root.appendChild(renderSeries(g));
  }

  function renderSeries(g) {
    const el = document.createElement('div');
    el.className = 'series' + (g.warnings ? ' bad' : '');
    el.innerHTML = `
      <div class="shead">
        <div class="stitle">${g.title ? esc(g.title) : '<span class="none">(作品名なし)</span>'}${
          g.author ? `<span class="sauthor">${esc(g.author)}</span>` : ''}</div>
        <div class="skey" title="${esc(g.key)}">${esc(g.key)}</div>
        ${g.warnings ? `<span class="swarn">要確認 ${g.warnings}</span>` : ''}
        <button type="button" class="small" data-act="edit">作品名を直す</button>
        <button type="button" class="small ghost" data-act="delall">まとめて消す</button>
      </div>
      <div class="sedit" hidden>
        <input type="text" data-f="title" value="${esc(g.title)}" placeholder="作品名 (巻数は入れなくて構いません)">
        <input type="text" data-f="author" value="${esc(g.author)}" placeholder="作者 (任意)">
        <button type="button" class="primary small" data-act="save">保存</button>
        <button type="button" class="ghost small" data-act="cancel">やめる</button>
      </div>
      <div class="lrows"></div>`;

    const edit = el.querySelector('.sedit');
    el.querySelector('[data-act=edit]').onclick = () => {
      edit.hidden = !edit.hidden;
      if (!edit.hidden) edit.querySelector('[data-f=title]').focus();
    };
    el.querySelector('[data-act=cancel]').onclick = () => { edit.hidden = true; };
    el.querySelector('[data-act=save]').onclick = () => ledgerAction(() =>
      api('POST', '/api/items/relabel', {
        userId: state.userId,
        seriesKey: g.key,
        title: edit.querySelector('[data-f=title]').value,
        author: edit.querySelector('[data-f=author]').value,
      }));
    el.querySelector('[data-act=delall]').onclick = () => {
      if (!confirm(`「${g.title || '(作品名なし)'}」の ${g.rows.length} 件を台帳から消しますか？\n`
        + '次に投入された時、また落としに行くようになります (手元のファイルは消えません)。')) return;
      ledgerAction(() => api('POST', '/api/items/delete', { ids: g.rows.map((r) => r.id) }));
    };

    const rows = el.querySelector('.lrows');
    for (const r of g.rows) rows.appendChild(renderLedgerRow(r));
    return el;
  }

  function renderLedgerRow(r) {
    const el = document.createElement('div');
    el.className = 'lrow';
    const meta = [
      r.job ? `ジョブ: ${STATUS_LABEL[r.job.status] || r.job.status}` : (r.jobId ? 'ジョブ: なし' : ''),
      r.job && r.job.filename,
      r.source,
      r.rawText,
    ].filter(Boolean).join(' · ');
    el.innerHTML = `
      <span class="badge i-${r.status}">${ITEM_STATUS[r.status] || r.status}</span>
      <span class="vol">${esc(volLabel(r))}</span>
      <span class="lmeta" title="${esc(meta)}">${esc(meta)}</span>
      <span class="lacts">
        <button type="button" class="small ghost" data-act="vol" title="読み違えた巻数を直す">巻数</button>
        <button type="button" class="small ghost" data-act="del" title="この行を消す">×</button>
      </span>
      ${r.warnings.length ? `<span class="lwarn">${esc(r.warnings.join('\n'))}</span>` : ''}`;

    el.querySelector('[data-act=vol]').onclick = () => {
      const v = prompt(`巻数を直します (3 または 1-7)\n${r.title || r.rawText || ''}`, volValue(r));
      if (v === null) return;
      ledgerAction(() => api('PATCH', `/api/items/${r.id}`, { volumes: v }));
    };
    el.querySelector('[data-act=del]').onclick = () => {
      if (!confirm(`${volLabel(r)} を台帳から消しますか？\n`
        + '次に投入された時、また落としに行くようになります (手元のファイルは消えません)。')) return;
      ledgerAction(() => api('DELETE', `/api/items/${r.id}`));
    };
    return el;
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
    // 台帳はユーザーごとに別物なので、開いたまま切り替えられたら中身も入れ替える
    if ($('itemsDialog').open) ledgerAction(async () => {});
  };
  $('showAll').onchange = (e) => { state.showAll = e.target.checked; renderJobs(); };
  $('btnUsers').onclick = () => { $('dialogError').hidden = true; $('usersDialog').showModal(); };
  $('btnItems').onclick = () => {
    $('itemsDialog').showModal();
    ledgerAction(async () => {});
  };
  $('btnItemsReload').onclick = () => ledgerAction(async () => {});
  $('itemFilter').oninput = (e) => { ledger.filter = e.target.value; renderLedger(); };
  $('itemOnlyBad').onchange = (e) => { ledger.onlyBad = e.target.checked; renderLedger(); };
  $('btnNewItem').onclick = () => ledgerAction(async () => {
    if (state.userId === null) throw new Error('先にユーザーを選んでください');
    const r = await api('POST', '/api/items', {
      userId: state.userId,
      title: $('newItemTitle').value,
      author: $('newItemAuthor').value || null,
      volumes: $('newItemVolumes').value,
    });
    $('newItemTitle').value = ''; $('newItemAuthor').value = ''; $('newItemVolumes').value = '';
    // 全部弾かれた時は黙って終わると「効いたのか分からない」ので、理由を出す
    if (r.created.length === 0) throw new Error(`登録しませんでした: 既に台帳にある巻です (${r.skipped} 件)`);
  });
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
