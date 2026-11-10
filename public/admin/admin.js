(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const content = $('#content');
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => { s = Number(s) || 0; return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
  const fmtLong = (s) => { s = Number(s) || 0; const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`; };
  const dt = (ms) => new Date(Number(ms)).toLocaleString('pt-BR');
  const kindBadge = (k) => `<span class="badge ${k}">${k === 'spot' ? 'Spot' : 'Música'}</span>`;

  const S = { companies: [], companyId: null, tab: 'live', timer: null, editingCampaign: null, playlistId: null };

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new Error('Sessão expirada'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
    return data;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b || {});
  const put = (u, b) => api('PUT', u, b || {});
  const del = (u) => api('DELETE', u);

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3000);
  }
  const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

  function uploadFiles(files, fields, barEl) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('company_id', S.companyId);
      for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, v);
      for (const f of files) fd.append('files', f);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
      xhr.upload.onprogress = (e) => { if (barEl && e.lengthComputable) barEl.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => {
        if (barEl) barEl.style.width = '0';
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* */ }
        xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `Erro ${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Falha de rede no envio'));
      xhr.send(fd);
    });
  }

  function bindDrop(el, onFiles) {
    const input = document.createElement('input');
    input.type = 'file'; input.multiple = true; input.accept = 'audio/*,.mpeg,.mpga'; input.hidden = true;
    el.appendChild(input);
    el.addEventListener('click', (e) => { if (e.target === el || e.target.closest('.drop-hint')) input.click(); });
    input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
    el.addEventListener('dragleave', () => el.classList.remove('over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault(); el.classList.remove('over');
      if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]);
    });
  }

  // ---------- login / sessão ----------
  function showLogin() {
    clearInterval(S.timer);
    $('#appView').hidden = true;
    $('#loginView').hidden = false;
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('POST', '/api/login', { user: fd.get('user'), password: fd.get('password') });
      boot();
    } catch (err) { $('#loginErr').textContent = err.message; }
  });

  $('#logoutBtn').addEventListener('click', async () => { await post('/api/logout'); showLogin(); });

  $('#companySel').addEventListener('change', (e) => {
    S.companyId = Number(e.target.value);
    localStorage.setItem('rs_company', S.companyId);
    S.playlistId = null; S.editingCampaign = null;
    renderTab();
  });

  $('#newCompanyBtn').addEventListener('click', guard(async () => {
    const name = prompt('Nome da empresa:');
    if (!name) return;
    const c = await post('/api/companies', { name });
    S.companyId = c.id;
    await loadCompanies();
    renderTab();
  }));

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    S.tab = b.dataset.tab;
    $$('#tabs button').forEach((x) => x.classList.toggle('active', x === b));
    renderTab();
  });

  async function loadCompanies() {
    S.companies = await get('/api/companies');
    const saved = Number(localStorage.getItem('rs_company'));
    if (!S.companies.some((c) => c.id === S.companyId)) {
      S.companyId = S.companies.some((c) => c.id === saved) ? saved : S.companies[0]?.id ?? null;
    }
    $('#companySel').innerHTML = S.companies.map((c) => `<option value="${c.id}" ${c.id === S.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
      || '<option>Nenhuma empresa</option>';
  }

  async function boot() {
    try { await get('/api/me'); } catch { return; }
    $('#loginView').hidden = true;
    $('#appView').hidden = false;
    await loadCompanies();
    renderTab();
  }

  function renderTab() {
    clearInterval(S.timer);
    if (!S.companyId) {
      content.innerHTML = `<div class="card"><h2>Bem-vindo!</h2><p>Comece cadastrando a primeira empresa.</p>
        <button class="primary" id="firstCompany">+ Cadastrar empresa</button></div>`;
      $('#firstCompany').onclick = () => $('#newCompanyBtn').click();
      return;
    }
    const fn = { live: renderLive, library: renderLibrary, playlists: renderPlaylists, campaigns: renderCampaigns, units: renderUnits, report: renderReport }[S.tab];
    guard(fn)();
  }

  // ======================= AO VIVO =======================
  async function renderLive() {
    const [units, media] = await Promise.all([
      get(`/api/units?company_id=${S.companyId}`),
      get(`/api/media?company_id=${S.companyId}`),
    ]);
    if (!units.length) {
      content.innerHTML = `<div class="card"><h2>Nenhuma unidade</h2><p class="muted">Cadastre uma unidade (loja/notebook) na aba <b>Unidades</b> para começar a tocar.</p></div>`;
      return;
    }
    const opts = (kind) => media.filter((m) => m.kind === kind)
      .map((m) => `<option value="${m.id}">${esc(m.title)}${m.artist ? ' — ' + esc(m.artist) : ''} (${fmt(m.duration)})</option>`).join('');
    const mediaSelect = `<option value="">Escolha um áudio…</option>
      <optgroup label="Spots">${opts('spot')}</optgroup><optgroup label="Músicas">${opts('music')}</optgroup>`;

    content.innerHTML = `<div class="grid">${units.map((u) => `
      <div class="card" data-unit="${u.id}">
        <div class="unit-head"><h3 style="margin:0">${esc(u.name)}</h3><span class="js-online"></span></div>
        <div class="now js-now"></div>
        <div class="controls">
          <button class="sm" data-cmd="skip" title="Pular">⏭ Pular</button>
          <button class="sm" data-cmd="pause">⏸ Pausar</button>
          <button class="sm" data-cmd="resume">▶ Retomar</button>
          <span class="muted" style="font-size:13px">Vol.</span>
          <input type="range" min="0" max="100" value="${u.volume ?? 100}" class="js-vol">
        </div>
        <h3>Fila ao vivo</h3>
        <ul class="qlist js-queue"></ul>
        <div class="row" style="margin-top:10px">
          <select class="js-media">${mediaSelect}</select>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="sm" data-q="next">➕ Tocar a seguir</button>
          <button class="sm primary" data-q="now">⚡ Tocar agora</button>
        </div>
        <div class="drop js-drop" style="margin-top:12px;padding:14px">
          <span class="drop-hint">Arraste um áudio novo aqui (ou clique) para <b>enviar e tocar a seguir</b></span>
          <div class="row" style="margin-top:8px;justify-content:center">
            <select class="js-upkind" style="flex:0 0 auto"><option value="spot">Spot</option><option value="music">Música</option></select>
          </div>
          <div class="progress"><div class="js-bar"></div></div>
        </div>
        <details style="margin-top:12px"><summary class="muted">Últimas execuções</summary><ul class="qlist js-recent"></ul></details>
      </div>`).join('')}</div>`;

    for (const card of $$('[data-unit]')) {
      const id = card.dataset.unit;
      card.addEventListener('click', guard(async (e) => {
        const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
        const q = e.target.closest('[data-q]')?.dataset.q;
        const cancel = e.target.closest('[data-cancel]')?.dataset.cancel;
        if (cmd) { await post(`/api/units/${id}/command`, { cmd }); toast('Comando enviado'); }
        if (q) {
          const mid = $('.js-media', card).value;
          if (!mid) return toast('Escolha um áudio');
          await post(`/api/units/${id}/queue`, { media_id: mid, mode: q });
          toast(q === 'now' ? 'Vai tocar em instantes' : 'Adicionado à fila');
          refreshUnit(card);
        }
        if (cancel) { await del(`/api/queue/${cancel}`); refreshUnit(card); }
      }));
      $('.js-vol', card).addEventListener('change', guard(async (e) => {
        await post(`/api/units/${id}/command`, { cmd: 'volume', value: e.target.value });
        toast(`Volume: ${e.target.value}%`);
      }));
      bindDrop($('.js-drop', card), guard(async (files) => {
        await uploadFiles(files, { kind: $('.js-upkind', card).value, queue_unit_id: id, queue_mode: 'next' }, $('.js-bar', card));
        toast('Enviado e adicionado à fila');
        refreshUnit(card);
      }));
      refreshUnit(card);
    }
    S.timer = setInterval(() => $$('[data-unit]').forEach((c) => refreshUnit(c)), 4000);
  }

  async function refreshUnit(card) {
    let d;
    try { d = await get(`/api/units/${card.dataset.unit}/live`); } catch { return; }
    const u = d.unit;
    const st = u.status;
    $('.js-online', card).innerHTML = u.online ? `<span class="badge on">● online · ${esc(st?.state || '')}</span>`
      : `<span class="badge off">● offline${u.last_seen ? ' desde ' + dt(u.last_seen) : ''}</span>`;
    const n = st?.now;
    const elapsed = n && u.online && st.state === 'tocando' ? Math.min(n.duration || 0, n.position + (Date.now() - st.at) / 1000) : n?.position || 0;
    $('.js-now', card).innerHTML = n ? `
      <div class="muted" style="font-size:12px">${n.kind === 'spot' ? 'SPOT' : 'TOCANDO'} · ${esc({ playlist: 'playlist', campaign: 'campanha', queue: 'fila ao vivo', spotify: 'Spotify' }[n.source] || '')}</div>
      <div class="t">${esc(n.title)}</div><div class="muted">${esc(n.artist || '')}</div>
      <div class="bar"><div style="width:${n.duration ? (elapsed / n.duration) * 100 : 0}%"></div></div>
      <div class="muted" style="font-size:13px;margin-top:6px">A seguir: ${esc(st.next || '—')}</div>`
      : '<span class="muted">Nada tocando no momento</span>';
    $('.js-queue', card).innerHTML = d.queue.length ? d.queue.map((q) => `
      <li><span>${kindBadge(q.kind)} ${esc(q.title)} ${q.mode === 'now' ? '<span class="badge">agora</span>' : ''} ${q.status === 'playing' ? '<span class="badge on">tocando</span>' : ''}</span>
      ${q.status === 'pending' ? `<button class="sm danger" data-cancel="${q.id}">✕</button>` : ''}</li>`).join('')
      : '<li class="muted">Fila vazia — tocando a programação automática</li>';
    $('.js-recent', card).innerHTML = d.recent.map((l) => `<li><span>${kindBadge(l.kind)} ${esc(l.title)}</span><span class="muted">${new Date(Number(l.played_at)).toLocaleTimeString('pt-BR')}</span></li>`).join('') || '<li class="muted">Sem registros</li>';
  }

  // ======================= BIBLIOTECA =======================
  async function renderLibrary() {
    content.innerHTML = `
      <div class="stack">
        <div class="card">
          <h2>Enviar áudios</h2>
          <div class="row" style="margin-bottom:12px">
            <label style="flex:0 0 200px">Tipo
              <select id="upKind"><option value="music">Música</option><option value="spot">Spot / anúncio</option></select></label>
            <label style="flex:0 0 260px">Adicionar à playlist (opcional)<select id="upPl"><option value="">—</option></select></label>
          </div>
          <div class="drop" id="drop"><span class="drop-hint">Arraste arquivos de áudio aqui ou <b>clique para escolher</b><br><small>MP3, M4A, AAC, OGG, WAV, FLAC — vários de uma vez</small></span>
            <div class="progress"><div id="upBar"></div></div></div>
        </div>
        <div class="card">
          <div class="row" style="margin-bottom:12px">
            <h2 style="flex:1 1 auto;margin:0">Biblioteca</h2>
            <input id="libSearch" placeholder="Buscar…" style="flex:0 1 240px">
            <select id="libKind" style="flex:0 0 150px"><option value="">Todos</option><option value="music">Músicas</option><option value="spot">Spots</option></select>
          </div>
          <div class="table-wrap"><table><thead><tr><th></th><th>Título</th><th>Artista</th><th>Tipo</th><th>Duração</th><th></th></tr></thead><tbody id="libBody"></tbody></table></div>
          <audio id="preview" controls style="width:100%;margin-top:12px" hidden></audio>
        </div>
      </div>`;

    const playlists = await get(`/api/playlists?company_id=${S.companyId}`);
    $('#upPl').innerHTML += playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    $('#upKind').onchange = () => { $('#upPl').disabled = $('#upKind').value === 'spot'; };

    let media = [];
    const draw = () => {
      const s = $('#libSearch').value.toLowerCase();
      const k = $('#libKind').value;
      const rows = media.filter((m) => (!k || m.kind === k) && (!s || `${m.title} ${m.artist || ''}`.toLowerCase().includes(s)));
      $('#libBody').innerHTML = rows.map((m) => `<tr data-id="${m.id}">
        <td><button class="sm" data-play="${esc(m.url)}">▶</button></td>
        <td><input value="${esc(m.title)}" data-f="title" style="width:100%"></td>
        <td><input value="${esc(m.artist || '')}" data-f="artist" style="width:100%"></td>
        <td><select data-f="kind"><option value="music" ${m.kind === 'music' ? 'selected' : ''}>Música</option><option value="spot" ${m.kind === 'spot' ? 'selected' : ''}>Spot</option></select></td>
        <td>${fmt(m.duration)}</td>
        <td><button class="sm danger" data-del>Excluir</button></td></tr>`).join('')
        || '<tr><td colspan="6" class="muted">Nenhum áudio ainda.</td></tr>';
    };
    const load = async () => { media = await get(`/api/media?company_id=${S.companyId}`); draw(); };
    $('#libSearch').oninput = draw;
    $('#libKind').onchange = draw;

    $('#libBody').addEventListener('change', guard(async (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      const id = e.target.closest('tr').dataset.id;
      await put(`/api/media/${id}`, { [f]: e.target.value });
      const m = media.find((x) => String(x.id) === id); if (m) m[f] = e.target.value;
      toast('Salvo');
    }));
    $('#libBody').addEventListener('click', guard(async (e) => {
      const tr = e.target.closest('tr');
      if (e.target.dataset.play) {
        const p = $('#preview'); p.hidden = false; p.src = e.target.dataset.play; p.play();
      }
      if (e.target.hasAttribute('data-del')) {
        if (!confirm('Excluir este áudio? Ele sai das playlists, campanhas e filas.')) return;
        await del(`/api/media/${tr.dataset.id}`); await load(); toast('Excluído');
      }
    }));

    bindDrop($('#drop'), guard(async (files) => {
      const created = await uploadFiles(files, { kind: $('#upKind').value }, $('#upBar'));
      const pl = $('#upPl').value;
      if (pl && $('#upKind').value === 'music') await post(`/api/playlists/${pl}/items`, { media_ids: created.map((m) => m.id) });
      toast(`${created.length} arquivo(s) enviado(s)`);
      await load();
    }));
    await load();
  }

  // ======================= PLAYLISTS =======================
  async function renderPlaylists() {
    const playlists = await get(`/api/playlists?company_id=${S.companyId}`);
    if (!playlists.some((p) => p.id === S.playlistId)) S.playlistId = playlists[0]?.id ?? null;

    content.innerHTML = `<div class="card" style="margin-bottom:16px;border-left:4px solid #1ed760">
        <b>Vai usar o Spotify?</b> <span class="muted">Esta aba é só para músicas enviadas na Biblioteca.
        A playlist do Spotify é cadastrada em <a href="#" id="goUnits">Unidades</a> → Fonte das músicas: Spotify → Link da playlist.</span>
      </div>
      <div class="split">
      <div class="card">
        <h2>Playlists</h2>
        <div class="pl-list">${playlists.map((p) => `<button data-pl="${p.id}" class="${p.id === S.playlistId ? 'active' : ''}">
          <span>${esc(p.name)}</span><span class="muted">${p.tracks} · ${fmtLong(p.total_duration)}</span></button>`).join('')}</div>
        <form id="newPl" class="row" style="margin-top:10px"><input name="name" placeholder="Nova playlist" required><button>Criar</button></form>
      </div>
      <div class="card" id="plDetail">${S.playlistId ? '' : '<p class="muted">Crie uma playlist para começar.</p>'}</div>
    </div>`;

    $('#goUnits').onclick = (e) => { e.preventDefault(); $('#tabs button[data-tab=units]').click(); };
    $$('[data-pl]').forEach((b) => b.onclick = () => { S.playlistId = Number(b.dataset.pl); renderPlaylists(); });
    $('#newPl').onsubmit = guard(async (e) => {
      e.preventDefault();
      const p = await post('/api/playlists', { company_id: S.companyId, name: new FormData(e.target).get('name') });
      S.playlistId = p.id; renderPlaylists();
    });
    if (!S.playlistId) return;

    const pl = playlists.find((p) => p.id === S.playlistId);
    const [items, music] = await Promise.all([
      get(`/api/playlists/${pl.id}/items`),
      get(`/api/media?company_id=${S.companyId}&kind=music`),
    ]);
    let ids = items.map((i) => i.id);
    const byId = new Map(music.map((m) => [m.id, m]));

    const box = $('#plDetail');
    box.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <input id="plName" value="${esc(pl.name)}" style="font-weight:600;font-size:18px">
        <label class="inline" style="flex:0 0 auto"><input type="checkbox" id="plShuffle" ${pl.shuffle ? 'checked' : ''}> Aleatório</label>
        <button class="danger" id="plDel">Excluir</button>
      </div>
      <div class="split" style="grid-template-columns:1fr 1fr">
        <div><h3>Na playlist <span class="muted" id="plCount"></span></h3><ul class="qlist" id="plItems"></ul></div>
        <div><h3>Adicionar músicas</h3>
          <input id="plSearch" placeholder="Buscar na biblioteca…" style="width:100%;margin-bottom:8px">
          <div class="pick" id="plPick"></div>
          <div class="row" style="margin-top:8px"><button id="plAdd" class="primary">Adicionar selecionadas</button><button id="plAll">Adicionar todas</button></div>
        </div>
      </div>`;

    const save = guard(async () => { await put(`/api/playlists/${pl.id}/items`, { media_ids: ids }); });
    const draw = () => {
      $('#plCount').textContent = `(${ids.length})`;
      $('#plItems').innerHTML = ids.map((id, i) => {
        const m = byId.get(id); if (!m) return '';
        return `<li data-i="${i}"><span>${i + 1}. ${esc(m.title)} <span class="muted">${esc(m.artist || '')} · ${fmt(m.duration)}</span></span>
          <span><button class="sm" data-up>↑</button><button class="sm" data-down>↓</button><button class="sm danger" data-rm>✕</button></span></li>`;
      }).join('') || '<li class="muted">Vazia</li>';
      const s = $('#plSearch').value.toLowerCase();
      $('#plPick').innerHTML = music.filter((m) => !ids.includes(m.id) && (!s || `${m.title} ${m.artist || ''}`.toLowerCase().includes(s)))
        .map((m) => `<label><input type="checkbox" value="${m.id}"> ${esc(m.title)} <span class="muted">${esc(m.artist || '')}</span></label>`).join('')
        || '<p class="muted" style="padding:10px">Nenhuma música disponível. Envie na aba Biblioteca.</p>';
    };
    draw();

    $('#plSearch').oninput = draw;
    $('#plItems').onclick = (e) => {
      const li = e.target.closest('li[data-i]'); if (!li) return;
      const i = Number(li.dataset.i);
      if (e.target.hasAttribute('data-rm')) ids.splice(i, 1);
      else if (e.target.hasAttribute('data-up') && i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
      else if (e.target.hasAttribute('data-down') && i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
      else return;
      draw(); save();
    };
    $('#plAdd').onclick = () => {
      const sel = $$('#plPick input:checked').map((x) => Number(x.value));
      if (!sel.length) return toast('Selecione músicas');
      ids = ids.concat(sel); draw(); save(); toast(`${sel.length} adicionada(s)`);
    };
    $('#plAll').onclick = () => {
      const sel = $$('#plPick input').map((x) => Number(x.value));
      ids = ids.concat(sel); draw(); save(); toast(`${sel.length} adicionada(s)`);
    };
    $('#plName').onchange = guard(async (e) => { await put(`/api/playlists/${pl.id}`, { name: e.target.value }); toast('Salvo'); });
    $('#plShuffle').onchange = guard(async (e) => { await put(`/api/playlists/${pl.id}`, { shuffle: e.target.checked }); toast('Salvo'); });
    $('#plDel').onclick = guard(async () => {
      if (!confirm('Excluir esta playlist?')) return;
      await del(`/api/playlists/${pl.id}`); S.playlistId = null; renderPlaylists();
    });
  }

  // ======================= CAMPANHAS (SPOTS) =======================
  const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const ruleText = (c) => c.mode === 'tracks' ? `a cada ${c.interval_value} música(s)`
    : c.mode === 'minutes' ? `a cada ${c.interval_value} min` : `às ${c.fixed_times}`;

  async function renderCampaigns() {
    const [campaigns, spots, units] = await Promise.all([
      get(`/api/campaigns?company_id=${S.companyId}`),
      get(`/api/media?company_id=${S.companyId}&kind=spot`),
      get(`/api/units?company_id=${S.companyId}`),
    ]);
    const c = S.editingCampaign || { all_spots: true, per_break: 1, mode: 'tracks', interval_value: 3, days: '0123456', hour_start: '00:00', hour_end: '23:59', priority: 0, active: true };

    content.innerHTML = `<div class="stack">
      <form class="card stack" id="campForm">
        <h2>${c.id ? 'Editar campanha' : 'Nova campanha de spot'}</h2>
        ${spots.length ? '' : '<p class="err">Envie primeiro um áudio do tipo <b>Spot</b> na Biblioteca.</p>'}
        <p class="muted" id="campHint" style="margin:0">Rodízio: o player toca a quantidade de spots escolhida a cada intervalo e continua de onde parou na próxima vez. Spots novos enviados na Biblioteca entram sozinhos.</p>
        <div class="row">
          <label>Nome<input name="name" required value="${esc(c.name || '')}" placeholder="Ex.: Promoção de verão"></label>
          <label>Spot<select name="media_id" id="campSpot" required><option value="all" ${c.all_spots ? 'selected' : ''}>★ Todos os spots (rodízio automático)</option>${spots.map((s) => `<option value="${s.id}" ${!c.all_spots && s.id === c.media_id ? 'selected' : ''}>${esc(s.title)} (${fmt(s.duration)})</option>`).join('')}</select></label>
          <label id="lblPerBreak">Quantos spots tocar<select name="per_break">
            ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<option value="${n}" ${Number(c.per_break) === n ? 'selected' : ''}>${n}</option>`).join('')}
            <option value="0" ${Number(c.per_break) === 0 ? 'selected' : ''}>Todos de uma vez</option></select></label>
          <label>Unidade<select name="unit_id"><option value="">Todas as unidades</option>${units.map((u) => `<option value="${u.id}" ${u.id === c.unit_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label>Regra<select name="mode" id="campMode">
            <option value="tracks" ${c.mode === 'tracks' ? 'selected' : ''}>A cada N músicas</option>
            <option value="minutes" ${c.mode === 'minutes' ? 'selected' : ''}>A cada N minutos</option>
            <option value="times" ${c.mode === 'times' ? 'selected' : ''}>Horários fixos</option></select></label>
          <label id="lblInterval"><span id="lblIntervalTxt">N</span><input name="interval_value" type="number" min="1" value="${c.interval_value || 3}"></label>
          <label id="lblTimes">Horários (separados por vírgula)<input name="fixed_times" value="${esc(c.fixed_times || '')}" placeholder="09:00, 12:00, 18:30"></label>
          <label>Prioridade<input name="priority" type="number" value="${c.priority || 0}"></label>
        </div>
        <div class="row">
          <label>Início (opcional)<input type="date" name="start_date" value="${c.start_date || ''}"></label>
          <label>Fim (opcional)<input type="date" name="end_date" value="${c.end_date || ''}"></label>
          <label>Das<input type="time" name="hour_start" value="${c.hour_start || '00:00'}"></label>
          <label>Até<input type="time" name="hour_end" value="${c.hour_end || '23:59'}"></label>
        </div>
        <div class="days">${DAYS.map((d, i) => `<label><input type="checkbox" name="day" value="${i}" ${String(c.days ?? '0123456').includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}
          <label style="margin-left:auto"><input type="checkbox" name="active" ${c.active ? 'checked' : ''}> Ativa</label></div>
        <div class="row"><button class="primary">${c.id ? 'Salvar alterações' : 'Criar campanha'}</button>${c.id ? '<button type="button" id="campCancel">Cancelar</button>' : ''}</div>
      </form>
      <div class="card">
        <h2>Campanhas</h2>
        <div class="table-wrap"><table><thead><tr><th>Ativa</th><th>Nome</th><th>Spot</th><th>Regra</th><th>Período</th><th>Dias / horário</th><th>Unidade</th><th></th></tr></thead>
        <tbody>${campaigns.map((x) => `<tr data-id="${x.id}">
          <td><input type="checkbox" data-toggle ${x.active ? 'checked' : ''}></td>
          <td>${esc(x.name)}</td><td>${x.all_spots ? `★ Rodízio (${x.per_break > 0 ? x.per_break : 'todos'} por intervalo)` : esc(x.media_title)}</td><td>${esc(ruleText(x))}</td>
          <td>${x.start_date || x.end_date ? `${x.start_date ? new Date(x.start_date + 'T12:00').toLocaleDateString('pt-BR') : '…'} → ${x.end_date ? new Date(x.end_date + 'T12:00').toLocaleDateString('pt-BR') : '…'}` : 'Sempre'}</td>
          <td>${String(x.days || '').split('').map((d) => DAYS[d]).join(', ')}<br><span class="muted">${x.hour_start}–${x.hour_end}</span></td>
          <td>${esc(x.unit_name || 'Todas')}</td>
          <td><button class="sm" data-edit>Editar</button> <button class="sm danger" data-del>✕</button></td></tr>`).join('')
          || '<tr><td colspan="8" class="muted">Nenhuma campanha.</td></tr>'}</tbody></table></div>
      </div></div>`;

    const syncMode = () => {
      const m = $('#campMode').value;
      $('#lblInterval').hidden = m === 'times';
      $('#lblTimes').hidden = m !== 'times';
      $('#lblIntervalTxt').textContent = m === 'tracks' ? 'A cada quantas músicas' : m === 'minutes' ? 'A cada quantos minutos' : 'N';
    };
    $('#campMode').onchange = syncMode; syncMode();
    const syncSpot = () => {
      const all = $('#campSpot').value === 'all';
      $('#lblPerBreak').hidden = !all;
      $('#campHint').hidden = !all;
    };
    $('#campSpot').onchange = syncSpot; syncSpot();

    $('#campForm').onsubmit = guard(async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        company_id: S.companyId,
        name: fd.get('name'),
        all_spots: fd.get('media_id') === 'all', media_id: fd.get('media_id') === 'all' ? null : Number(fd.get('media_id')),
        per_break: Number(fd.get('per_break') ?? 1), unit_id: fd.get('unit_id') ? Number(fd.get('unit_id')) : null,
        mode: fd.get('mode'), interval_value: Number(fd.get('interval_value')), fixed_times: fd.get('fixed_times'),
        priority: Number(fd.get('priority')), start_date: fd.get('start_date'), end_date: fd.get('end_date'),
        hour_start: fd.get('hour_start'), hour_end: fd.get('hour_end'),
        days: fd.getAll('day').join(''), active: fd.get('active') === 'on',
      };
      if (body.mode === 'times' && !/\d{1,2}:\d{2}/.test(body.fixed_times)) return toast('Informe ao menos um horário (ex.: 09:00)');
      if (!body.days) return toast('Marque ao menos um dia');
      if (c.id) await put(`/api/campaigns/${c.id}`, body); else await post('/api/campaigns', body);
      S.editingCampaign = null;
      toast('Campanha salva — as unidades recebem em segundos');
      renderCampaigns();
    });
    if (c.id) $('#campCancel').onclick = () => { S.editingCampaign = null; renderCampaigns(); };

    content.querySelector('tbody').addEventListener('click', guard(async (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const x = campaigns.find((k) => String(k.id) === tr.dataset.id);
      if (e.target.hasAttribute('data-edit')) { S.editingCampaign = x; renderCampaigns(); window.scrollTo(0, 0); }
      if (e.target.hasAttribute('data-del')) {
        if (!confirm('Excluir esta campanha?')) return;
        await del(`/api/campaigns/${x.id}`); renderCampaigns();
      }
    }));
    content.querySelector('tbody').addEventListener('change', guard(async (e) => {
      if (!e.target.hasAttribute('data-toggle')) return;
      await put(`/api/campaigns/${e.target.closest('tr').dataset.id}`, { active: e.target.checked });
      toast(e.target.checked ? 'Campanha ativada' : 'Campanha pausada');
    }));
  }

  // ======================= UNIDADES =======================
  async function renderUnits() {
    const [units, playlists] = await Promise.all([
      get(`/api/units?company_id=${S.companyId}`),
      get(`/api/playlists?company_id=${S.companyId}`),
    ]);
    const plOpts = (sel) => `<option value="">— sem playlist —</option>` + playlists.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    const link = (u) => `${location.origin}/player/?t=${u.token}`;

    content.innerHTML = `<div class="stack">
      <form class="card row" id="newUnit">
        <label>Nome da unidade<input name="name" required placeholder="Ex.: Loja Centro"></label>
        <label>Playlist<select name="playlist_id">${plOpts(null)}</select></label>
        <button class="primary">Adicionar unidade</button>
      </form>
      <div class="grid">${units.map((u) => `<div class="card stack" data-id="${u.id}">
        <div class="unit-head"><input value="${esc(u.name)}" data-f="name" style="font-weight:600;flex:1">
          ${u.online ? '<span class="badge on">online</span>' : '<span class="badge off">offline</span>'}</div>
        <label>Fonte das músicas<select data-f="music_source">
          <option value="library" ${u.music_source !== 'spotify' ? 'selected' : ''}>Acervo próprio (Biblioteca)</option>
          <option value="spotify" ${u.music_source === 'spotify' ? 'selected' : ''}>Spotify (conta Premium)</option></select></label>
        <label ${u.music_source === 'spotify' ? 'hidden' : ''}>Playlist<select data-f="playlist_id">${plOpts(u.playlist_id)}</select></label>
        <label ${u.music_source === 'spotify' ? '' : 'hidden'}>Link da playlist do Spotify
          <input data-f="spotify_playlist" value="${esc(u.spotify_playlist || '')}" placeholder="https://open.spotify.com/playlist/..."></label>
        <label>Volume dos spots<select data-f="spot_boost">
          ${[[100, 'Igual à música'], [125, '+25% mais alto'], [150, '+50% mais alto'], [175, '+75% mais alto'], [200, '+100% (dobro)'], [250, '+150%'], [300, '+200% (triplo)']]
            .map(([v, t]) => `<option value="${v}" ${Number(u.spot_boost ?? 100) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <div><div class="muted" style="font-size:13px;margin-bottom:4px">Link do player (abrir no notebook da unidade)</div>
          <code class="link">${esc(link(u))}</code></div>
        <div class="row">
          <button class="sm" data-copy="${esc(link(u))}">Copiar link</button>
          <button class="sm" data-open="${esc(link(u))}">Abrir player</button>
          <button class="sm" data-token>Gerar novo link</button>
          <button class="sm" data-reload>Recarregar player</button>
          <button class="sm danger" data-del>Excluir</button>
        </div>
      </div>`).join('')}</div></div>`;

    $('#newUnit').onsubmit = guard(async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await post('/api/units', { company_id: S.companyId, name: fd.get('name'), playlist_id: fd.get('playlist_id') || null });
      toast('Unidade criada'); renderUnits();
    });
    content.querySelector('.grid').addEventListener('change', guard(async (e) => {
      const f = e.target.dataset.f; if (!f) return;
      if (f === 'spotify_playlist' && e.target.value && !/playlist[/:][A-Za-z0-9]+/.test(e.target.value)) {
        return toast('Cole o link de uma playlist do Spotify (Compartilhar → Copiar link)');
      }
      await put(`/api/units/${e.target.closest('[data-id]').dataset.id}`, { [f]: e.target.value });
      toast('Salvo — a unidade atualiza em segundos');
      if (f === 'music_source') renderUnits();
    }));
    content.querySelector('.grid').addEventListener('click', guard(async (e) => {
      const card = e.target.closest('[data-id]'); if (!card) return;
      const id = card.dataset.id;
      if (e.target.dataset.copy) { await navigator.clipboard.writeText(e.target.dataset.copy); toast('Link copiado'); }
      if (e.target.dataset.open) window.open(e.target.dataset.open, '_blank');
      if (e.target.hasAttribute('data-reload')) { await post(`/api/units/${id}/command`, { cmd: 'reload' }); toast('Comando enviado'); }
      if (e.target.hasAttribute('data-token')) {
        if (!confirm('O link atual deixará de funcionar. Continuar?')) return;
        await post(`/api/units/${id}/token`); renderUnits();
      }
      if (e.target.hasAttribute('data-del')) {
        if (!confirm('Excluir esta unidade e seu histórico?')) return;
        await del(`/api/units/${id}`); renderUnits();
      }
    }));
  }

  // ======================= RELATÓRIO =======================
  async function renderReport() {
    const units = await get(`/api/units?company_id=${S.companyId}`);
    const today = new Date().toLocaleDateString('sv-SE');
    content.innerHTML = `<div class="card stack">
      <h2>Relatório de veiculação</h2>
      <form class="row" id="repForm">
        <label>Unidade<select name="unit_id"><option value="">Todas</option>${units.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select></label>
        <label>Tipo<select name="kind"><option value="spot">Spots</option><option value="music">Músicas</option><option value="">Tudo</option></select></label>
        <label>De<input type="date" name="from" value="${today}"></label>
        <label>Até<input type="date" name="to" value="${today}"></label>
        <button class="primary">Filtrar</button>
        <button type="button" id="repCsv">Exportar CSV</button>
      </form>
      <div id="repSummary"></div>
      <div class="table-wrap"><table><thead><tr><th>Data/hora</th><th>Unidade</th><th>Tipo</th><th>Título</th><th>Origem</th></tr></thead><tbody id="repBody"></tbody></table></div>
    </div>`;
    const qs = () => new URLSearchParams({ company_id: S.companyId, ...Object.fromEntries(new FormData($('#repForm'))) }).toString();
    const load = guard(async () => {
      const rows = await get(`/api/logs?${qs()}`);
      const count = {};
      rows.forEach((r) => { count[r.title] = (count[r.title] || 0) + 1; });
      const top = Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 8);
      $('#repSummary').innerHTML = rows.length ? `<p><b>${rows.length}</b> execuções${rows.length >= 500 ? ' (mostrando as 500 mais recentes; exporte o CSV para ver tudo)' : ''}.</p>
        <p class="muted">${top.map(([t, n]) => `${esc(t)}: <b>${n}×</b>`).join(' · ')}</p>` : '';
      $('#repBody').innerHTML = rows.map((r) => `<tr><td>${dt(r.played_at)}</td><td>${esc(r.unit_name)}</td><td>${kindBadge(r.kind)}</td><td>${esc(r.title)}</td>
        <td class="muted">${esc({ playlist: 'Playlist', campaign: 'Campanha', queue: 'Fila ao vivo', spotify: 'Spotify' }[r.source] || r.source)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="muted">Nenhum registro no período.</td></tr>';
    });
    $('#repForm').onsubmit = (e) => { e.preventDefault(); load(); };
    $('#repCsv').onclick = () => { window.location = `/api/logs?${qs()}&format=csv`; };
    load();
  }

  boot().then(() => { if ($('#appView').hidden) showLogin(); });
})();
