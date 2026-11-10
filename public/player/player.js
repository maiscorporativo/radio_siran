/* Rádio Siran — player da unidade
 * - Toca músicas da playlist + spots conforme as campanhas
 * - Recebe fila ao vivo e comandos do painel (sync a cada 5s)
 * - Guarda áudios e configuração localmente: segue tocando se a internet cair
 */
(() => {
  'use strict';

  const SYNC_MS = 5000;
  const HEARTBEAT_MS = 15000;
  const FADE_MS = 1200;
  const TIMES_GRACE_MS = 60 * 60 * 1000; // spot de horário fixo ainda vale até 1h depois
  const MEDIA_CACHE = 'rs-media-v1';

  // ---------- estado persistente ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem('rs_' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem('rs_' + k, JSON.stringify(v)); } catch { /* cheio */ } },
  };

  const params = new URLSearchParams(location.search);
  const token = params.get('t') || store.get('token', null);
  if (params.get('t')) store.set('token', params.get('t'));

  const $ = (id) => document.getElementById(id);
  const audio = $('audio');

  let config = store.get('config', null);
  let online = false;
  let started = false;
  let paused = false;
  let current = null; // { media, source, queueId, campaignId }
  let gain = 1;
  let lastProgressAt = Date.now();

  // Spotify (quando a unidade usa music_source = 'spotify')
  const sp = { ready: false, started: false, playlist: null, needsNext: false, busy: false, polling: false,
    trackId: null, pos: 0, dur: 0, at: 0, paused: true, missing: 0, nextTitle: null, gain: 1 };
  const isSpotify = () => config?.unit?.music_source === 'spotify' && !!config?.unit?.spotify_playlist;

  const spotBlock = [];               // spots devidos aguardando a vez
  let resumeItem = null;              // música interrompida por "tocar agora"
  const takenQueue = new Set(store.get('takenQueue', []));
  const doneCommands = new Set(store.get('doneCommands', []));
  const spotState = store.get('spotState', { tracksSince: {}, lastPlayed: {}, fired: {} });
  spotState.rot = spotState.rot || {};
  let order = store.get('order', { sig: '', ids: [], pos: 0 });
  let pendingLogs = store.get('pendingLogs', []);
  let pendingAcks = store.get('pendingAcks', { queue_playing: [], queue_done: [], commands_done: [] });

  const saveState = () => {
    store.set('spotState', spotState);
    store.set('order', order);
    store.set('takenQueue', [...takenQueue].slice(-500));
    store.set('doneCommands', [...doneCommands].slice(-500));
    store.set('pendingLogs', pendingLogs.slice(-2000));
    store.set('pendingAcks', pendingAcks);
  };

  // ---------- utilidades ----------
  const fmt = (s) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
  const api = (p) => `${p}${p.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function setStatus(t) { $('statusText').textContent = t; }

  // ---------- cache de áudio ----------
  async function cachedBlobUrl(media) {
    let res = null;
    try {
      const cache = await caches.open(MEDIA_CACHE);
      res = await cache.match(media.url);
      if (!res) {
        const net = await fetch(api(media.url));
        if (!net.ok) throw new Error('HTTP ' + net.status);
        await cache.put(media.url, net.clone());
        res = net;
      }
    } catch (e) {
      // sem Cache API (http não seguro) → toca direto da rede
      if (!res && !('caches' in window)) return api(media.url);
      if (!res) throw e;
    }
    return URL.createObjectURL(await res.blob());
  }

  let prefetching = false;
  async function prefetchAll() {
    if (prefetching || !config || !('caches' in window)) return;
    prefetching = true;
    try {
      const cache = await caches.open(MEDIA_CACHE);
      const wanted = new Map();
      (config.campaigns || []).forEach((c) => (c.pool || [c.media]).forEach((m) => wanted.set(m.url, m)));
      (config.queue || []).forEach((q) => wanted.set(q.media.url, q.media));
      (config.playlist?.tracks || []).forEach((t) => wanted.set(t.url, t));
      let have = 0;
      for (const [url] of wanted) {
        if (await cache.match(url)) { have++; continue; }
        if (!online) continue;
        try {
          const res = await fetch(api(url));
          if (res.ok) { await cache.put(url, res); have++; }
        } catch { /* tenta no próximo ciclo */ }
      }
      $('cacheText').textContent = `${have}/${wanted.size} áudios offline`;
      // remove do cache o que não é mais usado
      for (const req of await cache.keys()) {
        const p = new URL(req.url).pathname;
        if (!wanted.has(p) && p !== current?.media?.url) await cache.delete(req);
      }
    } finally {
      prefetching = false;
    }
  }

  // ---------- volume / fade ----------
  const baseVolume = () => Math.max(0, Math.min(1, (config?.unit?.volume ?? 100) / 100));
  const spotBoost = () => Math.max(1, Math.min(3, (config?.unit?.spot_boost ?? 100) / 100));

  // Reforço acima de 100% passa por Web Audio (ganho + limitador para não distorcer).
  // Só é montado quando necessário e com o áudio já liberado pelo navegador.
  let boostNode = null;
  let boostBuilding = false;
  function ensureBoostGraph() {
    if (boostNode || boostBuilding || !window.AudioContext) return;
    boostBuilding = true;
    let ctx;
    try { ctx = new AudioContext(); } catch { boostBuilding = false; return; }
    const build = () => {
      try {
        const src = ctx.createMediaElementSource(audio);
        const g = ctx.createGain();
        const lim = ctx.createDynamicsCompressor();
        lim.threshold.value = -2; lim.knee.value = 0; lim.ratio.value = 20;
        lim.attack.value = 0.003; lim.release.value = 0.25;
        src.connect(g); g.connect(lim); lim.connect(ctx.destination);
        ctx.onstatechange = () => { if (ctx.state === 'suspended') ctx.resume().catch(() => {}); };
        boostNode = g;
        applyVolume();
      } catch (e) { console.warn('Reforço de volume indisponível', e); }
    };
    ctx.resume().catch(() => {}).finally(() => {
      if (ctx.state === 'running') build(); else ctx.close().catch(() => {});
      boostBuilding = false;
    });
  }

  const applyVolume = () => {
    const boost = current?.media?.kind === 'spot' ? spotBoost() : 1;
    const v = Math.max(0, baseVolume() * gain * boost);
    if (v > 1 && !boostNode) ensureBoostGraph();
    audio.volume = Math.min(1, v);
    if (boostNode) boostNode.gain.value = Math.max(1, v);
  };

  function fadeTo(target, ms = FADE_MS) {
    return new Promise((resolve) => {
      const from = gain;
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / ms);
        gain = from + (target - from) * k;
        applyVolume();
        if (k < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  // ---------- regras de campanha ----------
  function inWindow(c, d) {
    const today = localDate(d);
    if (c.start_date && today < c.start_date) return false;
    if (c.end_date && today > c.end_date) return false;
    if (c.days && !c.days.includes(String(d.getDay()))) return false;
    const now = hm(d);
    const a = c.hour_start || '00:00';
    const b = c.hour_end || '23:59';
    return a <= b ? now >= a && now <= b : now >= a || now <= b; // suporta virada da meia-noite
  }

  function dueCampaigns() {
    const d = new Date();
    const nowMs = d.getTime();
    const due = [];
    for (const c of config?.campaigns || []) {
      if (!inWindow(c, d)) continue;
      if (spotBlock.some((s) => s.campaignId === c.id)) continue;
      if (c.mode === 'tracks') {
        if ((spotState.tracksSince[c.id] || 0) >= c.interval_value) due.push({ c });
      } else if (c.mode === 'minutes') {
        if (!spotState.lastPlayed[c.id]) spotState.lastPlayed[c.id] = nowMs; // começa a contar agora
        if (nowMs - spotState.lastPlayed[c.id] >= c.interval_value * 60000) due.push({ c });
      } else if (c.mode === 'times') {
        const fired = spotState.fired[c.id] || [];
        for (const t of String(c.fixed_times || '').split(/[,;\s]+/).filter(Boolean)) {
          const [h, m] = t.split(':').map(Number);
          if (isNaN(h)) continue;
          const at = new Date(d); at.setHours(h, m || 0, 0, 0);
          const key = `${localDate(d)} ${pad(h)}:${pad(m || 0)}`;
          if (nowMs >= at.getTime() && nowMs - at.getTime() < TIMES_GRACE_MS && !fired.includes(key)) {
            due.push({ c, key });
            break;
          }
        }
      }
    }
    return due.sort((a, b) => (b.c.priority || 0) - (a.c.priority || 0));
  }

  function enqueueDueSpots() {
    for (const { c, key } of dueCampaigns()) {
      if (!c.pool?.length) {
        spotBlock.push({ media: c.media, source: 'campaign', campaignId: c.id, firedKey: key });
        continue;
      }
      // rodízio: continua de onde parou na lista de spots da empresa
      const n = c.per_break > 0 ? Math.min(c.per_break, c.pool.length) : c.pool.length;
      let i = (spotState.rot[c.id] || 0) % c.pool.length;
      for (let k = 0; k < n; k++) {
        spotBlock.push({ media: c.pool[i], source: 'campaign', campaignId: c.id, firedKey: key });
        i = (i + 1) % c.pool.length;
      }
      spotState.rot[c.id] = i;
    }
  }

  function markSpotPlayed(item) {
    const id = item.campaignId;
    spotState.tracksSince[id] = 0;
    spotState.lastPlayed[id] = Date.now();
    if (item.firedKey) {
      const list = (spotState.fired[id] || []).filter((k) => k.startsWith(localDate())); // limpa dias anteriores
      list.push(item.firedKey);
      spotState.fired[id] = list;
    }
  }

  // ---------- ordem das músicas ----------
  function nextMusic() {
    const tracks = config?.playlist?.tracks || [];
    if (!tracks.length) return null;
    const byId = new Map(tracks.map((t) => [t.id, t]));
    const sig = `${config.playlist.id}:${config.playlist.shuffle}:${tracks.map((t) => t.id).join(',')}`;
    if (order.sig !== sig || order.pos >= order.ids.length) {
      const lastId = current?.media?.kind === 'music' ? current.media.id : null;
      let ids = tracks.map((t) => t.id);
      if (config.playlist.shuffle) {
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        if (ids.length > 1 && ids[0] === lastId) [ids[0], ids[1]] = [ids[1], ids[0]];
      } else if (order.sig === sig && lastId) {
        // sem shuffle e reiniciando: volta ao começo
      } else if (lastId && ids.includes(lastId)) {
        // playlist mudou: continua a partir da música atual
        const i = ids.indexOf(lastId);
        ids = ids.slice(i + 1).concat(ids.slice(0, i + 1));
      }
      order = { sig, ids, pos: 0 };
    }
    const id = order.ids[order.pos++];
    return byId.get(id) ? { media: byId.get(id), source: 'playlist' } : nextMusic();
  }

  function peekNextTitle() {
    const q = (config?.queue || []).find((x) => !takenQueue.has(x.id));
    if (q) return `${q.media.title} · fila`;
    if (resumeItem) return `${resumeItem.media.title} · retomando`;
    if (spotBlock.length) return `${spotBlock[0].media.title} · spot`;
    if (isSpotify()) return sp.nextTitle || 'Spotify';
    const tracks = config?.playlist?.tracks || [];
    const id = order.ids[order.pos];
    const t = tracks.find((x) => x.id === id);
    return t ? t.title + (t.artist ? ` — ${t.artist}` : '') : '—';
  }

  // ---------- escolha do próximo item ----------
  function pickNext() {
    // 1) fila ao vivo (ordem de chegada)
    const q = (config?.queue || []).find((x) => !takenQueue.has(x.id));
    if (q) {
      takenQueue.add(q.id);
      return { media: q.media, source: 'queue', queueId: q.id };
    }
    // 2) música interrompida por um "tocar agora"
    if (resumeItem) { const r = resumeItem; resumeItem = null; return r; }
    // 3) spots devidos
    if (current?.source !== 'campaign') enqueueDueSpots();
    if (spotBlock.length) return spotBlock.shift();
    // 4) música da playlist (Spotify ou acervo próprio)
    if (isSpotify()) {
      return { spotify: true, source: 'spotify', media: current?.source === 'spotify' ? current.media : { kind: 'music', title: 'Spotify', artist: '' } };
    }
    return nextMusic();
  }

  // ---------- reprodução ----------
  let playToken = 0;

  async function playItem(item) {
    const my = ++playToken;
    if (!item) {
      current = null;
      render();
      setStatus(config ? 'Sem músicas na playlist — aguardando conteúdo' : 'Aguardando configuração');
      await sleep(5000);
      if (my === playToken) playNext();
      return;
    }
    if (item.spotify) return playSpotify(item, my);
    let src;
    try {
      src = await cachedBlobUrl(item.media);
    } catch (e) {
      console.warn('Falha ao carregar', item.media.title, e);
      setStatus(`Não foi possível carregar "${item.media.title}" (offline e sem cache)`);
      if (item.source === 'queue') ackLater('queue_done', item.queueId);
      await sleep(1500);
      if (my === playToken) playNext();
      return;
    }
    if (my !== playToken) { URL.revokeObjectURL(src); return; }

    const old = audio.src;
    current = item;
    audio.src = src;
    if (old.startsWith('blob:')) URL.revokeObjectURL(old);
    if (item.resumeAt) audio.currentTime = item.resumeAt;
    gain = 1; applyVolume();

    try {
      if (!paused) await audio.play();
    } catch (e) {
      if (e.name === 'NotAllowedError') { showStart(); return; }
      console.warn(e);
    }

    if (item.source === 'campaign') markSpotPlayed(item);
    if (item.source === 'queue') ackLater('queue_playing', item.queueId);
    if (!item.resumeAt) {
      pendingLogs.push({
        ref: uid(), media_id: item.media.id, kind: item.media.kind, title: item.media.title,
        source: item.source, campaign_id: item.campaignId || null, played_at: Date.now(),
      });
    }
    lastProgressAt = Date.now();
    saveState();
    render();
    setStatus(online ? 'No ar' : 'No ar (offline — usando cache)');
  }

  function playNext() {
    return playItem(pickNext());
  }

  // ---------- Spotify ----------
  async function ensureSpotify() {
    if (sp.ready) return true;
    if (location.hostname === 'localhost') { // o Spotify só aceita 127.0.0.1 como endereço local
      location.replace(location.href.replace('//localhost', '//127.0.0.1'));
      return false;
    }
    const cid = config?.unit?.spotify_client_id;
    if (!cid) { setStatus('Spotify: falta configurar SPOTIFY_CLIENT_ID no servidor (.env)'); return false; }
    if (!RSpotify.isConnected()) {
      $('spotifyOverlay').hidden = false;
      $('spotifyBtn').onclick = () => RSpotify.login(cid);
      setStatus('Aguardando conexão com o Spotify');
      return false;
    }
    $('spotifyOverlay').hidden = true;
    try {
      await RSpotify.init(`Rádio Siran · ${config.unit.name}`, (msg) => setStatus(msg));
      sp.ready = true;
      return true;
    } catch (e) {
      setStatus(e.message);
      return false;
    }
  }

  async function spFade(target, ms = 600) {
    const steps = 8;
    const from = sp.gain;
    for (let i = 1; i <= steps; i++) {
      sp.gain = from + (target - from) * (i / steps);
      await RSpotify.setVolume(baseVolume() * sp.gain);
      await sleep(ms / steps);
    }
  }

  async function spPause() {
    sp.busy = true;
    try { await spFade(0, 600); await RSpotify.pause(); } catch { /* */ } finally { sp.busy = false; }
  }

  async function playSpotify(item, my) {
    if (!(await ensureSpotify())) {
      await sleep(5000);
      if (my === playToken) playNext();
      return;
    }
    if (my !== playToken) return;
    sp.busy = true;
    try {
      audio.pause();
      current = item;
      const pl = config.unit.spotify_playlist;
      if (!sp.started || sp.playlist !== pl) {
        sp.gain = 1;
        await RSpotify.setVolume(baseVolume());
        await RSpotify.start(pl, config.playlist?.shuffle ?? true);
        sp.started = true; sp.playlist = pl; sp.trackId = null;
      } else if (sp.needsNext) {
        await RSpotify.next();
        await RSpotify.resume();
      } else {
        await RSpotify.resume();
      }
      sp.needsNext = false;
      if (sp.gain < 1) await spFade(1, 500);
      lastProgressAt = Date.now();
      setStatus('No ar · Spotify');
      render();
    } catch (e) {
      console.warn(e);
      setStatus(`Spotify: ${e.message}`);
      sp.started = false;
      sp.busy = false;
      await sleep(5000);
      if (my === playToken) playNext();
      return;
    } finally {
      sp.busy = false;
    }
  }

  const hasBreakPending = () =>
    (config?.queue || []).some((q) => !takenQueue.has(q.id)) || spotBlock.length > 0 || dueCampaigns().length > 0;

  // Acompanha a faixa do Spotify: registra cada música e abre espaço para spots/fila no fim da faixa
  async function spotifyPoll() {
    if (sp.polling || sp.busy || paused || !sp.ready || current?.source !== 'spotify') return;
    sp.polling = true;
    try {
      const st = await RSpotify.state().catch(() => null);
      if (sp.busy || current?.source !== 'spotify') return;
      if (!st) {
        sp.missing++;
        if (sp.missing === 20) { setStatus('Spotify saiu deste aparelho — retomando…'); RSpotify.reclaim().catch(() => {}); }
        if (sp.missing > 60) sp.missing = 0;
        return;
      }
      sp.missing = 0;
      Object.assign(sp, { pos: st.position, dur: st.duration, at: Date.now(), paused: st.paused });
      const nt = st.track_window?.next_tracks?.[0];
      sp.nextTitle = nt ? `${nt.name} — ${(nt.artists || []).map((a) => a.name).join(', ')}` : null;
      if (!st.paused) lastProgressAt = Date.now();

      const t = st.track_window?.current_track;
      if (t && t.id !== sp.trackId) {
        sp.trackId = t.id;
        const artist = (t.artists || []).map((a) => a.name).join(', ');
        current.media = { kind: 'music', title: t.name, artist, duration: st.duration / 1000 };
        for (const c of config?.campaigns || []) {
          if (c.mode === 'tracks') spotState.tracksSince[c.id] = (spotState.tracksSince[c.id] || 0) + 1;
        }
        pendingLogs.push({
          ref: uid(), media_id: null, kind: 'music', title: artist ? `${t.name} — ${artist}` : t.name,
          source: 'spotify', campaign_id: null, played_at: Date.now(),
        });
        saveState();
        render();
      }

      const remaining = st.duration - st.position;
      if (!st.paused && st.duration > 0 && remaining <= 1500 && hasBreakPending()) {
        await spPause();
        sp.needsNext = true;
        onEnded();
      }
    } finally {
      sp.polling = false;
    }
  }

  function positionNow() {
    if (current?.source === 'spotify') {
      return { pos: (sp.pos + (sp.paused ? 0 : Date.now() - sp.at)) / 1000, dur: sp.dur / 1000 };
    }
    return { pos: audio.currentTime || 0, dur: audio.duration || current?.media?.duration || 0 };
  }

  function onEnded() {
    const item = current;
    if (item?.media.kind === 'music' && item.source !== 'spotify') { // Spotify conta no início da faixa
      for (const c of config?.campaigns || []) {
        if (c.mode === 'tracks') spotState.tracksSince[c.id] = (spotState.tracksSince[c.id] || 0) + 1;
      }
    }
    if (item?.source === 'queue') ackLater('queue_done', item.queueId);
    saveState();
    playNext();
  }

  async function interruptWith(qItem) {
    takenQueue.add(qItem.id);
    if (current?.source === 'spotify') {
      await spPause();
      sp.needsNext = false; // depois retoma a mesma faixa de onde parou
    } else if (current && current.media.kind === 'music' && !audio.ended && audio.currentTime > 2) {
      resumeItem = { ...current, resumeAt: Math.max(0, audio.currentTime - 1) };
    }
    if (current?.source === 'queue') ackLater('queue_done', current.queueId);
    if (!audio.paused) await fadeTo(0, 600);
    await playItem({ media: qItem.media, source: 'queue', queueId: qItem.id });
  }

  async function skip() {
    if (current?.source === 'spotify') { await RSpotify.next(); return; }
    if (!audio.paused) await fadeTo(0, 500);
    onEnded();
  }

  // ---------- comandos do painel ----------
  async function runCommands() {
    for (const c of config?.commands || []) {
      if (doneCommands.has(c.id)) continue;
      doneCommands.add(c.id);
      ackLater('commands_done', c.id);
      switch (c.cmd) {
        case 'skip': await skip(); break;
        case 'pause':
          paused = true;
          if (current?.source === 'spotify') await spPause();
          else { await fadeTo(0, 500); audio.pause(); }
          setStatus('Pausado pelo painel');
          break;
        case 'resume':
          paused = false;
          if (current?.source === 'spotify') { await RSpotify.resume(); spFade(1, 500); }
          else { gain = 0; applyVolume(); audio.play().catch(() => {}); fadeTo(1, 500); }
          setStatus('No ar');
          break;
        case 'volume':
          if (config.unit) config.unit.volume = Number(c.value);
          applyVolume();
          if (current?.source === 'spotify') RSpotify.setVolume(baseVolume() * sp.gain);
          break;
        case 'reload': saveState(); await flushAcks(); location.reload(); return;
      }
    }
    saveState();
  }

  // ---------- comunicação com o servidor ----------
  function ackLater(kind, id) {
    if (id == null) return;
    if (!pendingAcks[kind].includes(id)) pendingAcks[kind].push(id);
    saveState();
    flushAcks();
  }

  async function flushAcks() {
    const body = pendingAcks;
    if (!body.queue_playing.length && !body.queue_done.length && !body.commands_done.length) return;
    try {
      const res = await fetch(api('/api/player/ack'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) {
        for (const k of Object.keys(body)) {
          pendingAcks[k] = pendingAcks[k].filter((id) => !body[k].includes(id));
        }
        saveState();
      }
    } catch { /* offline: reenvia depois */ }
  }

  async function sync() {
    try {
      const res = await fetch(api('/api/player/sync'), { cache: 'no-cache' });
      if (res.status === 401) return showError('Token da unidade inválido. Gere o link do player novamente no painel.');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      setOnline(true);
      const firstLoad = !config;
      config = data;
      store.set('config', config);
      $('unitName').textContent = `${data.unit.company || ''} · ${data.unit.name}`;
      applyVolume();

      // "tocar agora" interrompe imediatamente
      const now = data.queue.find((q) => q.mode === 'now' && !takenQueue.has(q.id));
      if (now && started) await interruptWith(now);

      await runCommands();
      // painel trocou a fonte de Spotify para acervo próprio: para o Spotify e segue
      if (started && current?.source === 'spotify' && !isSpotify() && !sp.busy) {
        await spPause();
        playNext();
      }
      prefetchAll();
      if (firstLoad && started && !current) playNext();
      render();
    } catch (e) {
      setOnline(false);
    }
  }

  async function heartbeat() {
    const logs = pendingLogs.slice(0, 200);
    const status = {
      state: !started ? 'aguardando' : paused ? 'pausado' : audio.paused ? 'parado' : 'tocando',
      now: current ? {
        title: current.media.title, artist: current.media.artist, kind: current.media.kind,
        source: current.source, position: Math.round(positionNow().pos),
        duration: Math.round(positionNow().dur),
      } : null,
      next: peekNextTitle(),
      cache: $('cacheText').textContent,
      at: Date.now(),
    };
    try {
      const res = await fetch(api('/api/player/heartbeat'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status, logs }),
      });
      if (res.ok) {
        const refs = new Set(logs.map((l) => l.ref));
        pendingLogs = pendingLogs.filter((l) => !refs.has(l.ref));
        saveState();
        setOnline(true);
      }
    } catch {
      setOnline(false);
    }
    flushAcks();
  }

  function setOnline(v) {
    online = v;
    $('netDot').className = 'dot ' + (v ? 'on' : 'off');
  }

  // ---------- tela ----------
  function render() {
    const m = current?.media;
    document.body.classList.toggle('is-spot', m?.kind === 'spot');
    $('nowLabel').textContent = !m ? 'Tocando agora' : m.kind === 'spot' ? 'Spot' : current.source === 'queue' ? 'Fila ao vivo' : 'Tocando agora';
    $('nowTitle').textContent = m ? m.title : 'Aguardando…';
    $('nowArtist').textContent = m?.artist || '';
    $('nextTitle').textContent = peekNextTitle();
  }

  function tick() {
    const d = new Date();
    $('clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const { pos, dur } = positionNow();
    $('progress').style.width = dur ? `${Math.min(100, (pos / dur) * 100)}%` : '0';
    $('tCur').textContent = fmt(pos);
    $('tDur').textContent = fmt(dur);
    // watchdog: áudio travado há mais de 30s → pula
    const waitingClick = !$('startOverlay').hidden;
    if (waitingClick) lastProgressAt = Date.now();
    if (started && !paused && !waitingClick && current && Date.now() - lastProgressAt > 30000) {
      console.warn('Watchdog: áudio travado, pulando');
      lastProgressAt = Date.now();
      onEnded();
    }
  }

  function showStart() {
    $('startOverlay').hidden = false;
  }

  function showError(msg) {
    $('errorText').textContent = msg;
    $('errorOverlay').hidden = false;
  }

  async function start() {
    $('startOverlay').hidden = true;
    started = true;
    RSpotify.activate(); // libera o áudio do Spotify com o clique do usuário
    if (spotBoost() > 1) ensureBoostGraph();
    if (current && audio.src) {
      audio.play().catch(() => showStart());
    } else {
      playNext();
    }
  }

  // ---------- eventos ----------
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('timeupdate', () => { lastProgressAt = Date.now(); });
  audio.addEventListener('pause', () => { if (paused) lastProgressAt = Date.now(); });
  audio.addEventListener('error', () => {
    console.warn('Erro de áudio em', current?.media?.title);
    setTimeout(onEnded, 1000);
  });
  $('startBtn').addEventListener('click', start);
  setInterval(() => { if (paused) lastProgressAt = Date.now(); }, 5000);

  // ---------- inicialização ----------
  if (!token) {
    showError('Abra o link do player gerado no painel (Unidades → Link do player).');
    return;
  }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

  if (config) {
    $('unitName').textContent = `${config.unit.company || ''} · ${config.unit.name}`;
    applyVolume();
  }
  render();
  setInterval(tick, 500);
  setInterval(spotifyPoll, 500);
  setInterval(sync, SYNC_MS);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(prefetchAll, 10 * 60 * 1000);

  sync().finally(() => {
    // tenta iniciar sozinho (funciona com o atalho de kiosk / autoplay liberado)
    started = true;
    playNext();
    heartbeat();
  });
})();
