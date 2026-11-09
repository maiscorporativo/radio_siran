/* Rádio Siran — integração com Spotify (Web Playback SDK + Web API)
 * Login com PKCE direto no navegador do player (não precisa de client secret).
 * Requer conta Premium e Chrome/Edge desktop.
 */
(() => {
  'use strict';

  const SCOPES = [
    'streaming', 'user-read-email', 'user-read-private',
    'user-read-playback-state', 'user-modify-playback-state',
    'playlist-read-private', 'playlist-read-collaborative',
  ].join(' ');
  const KEY = 'rs_spotify';
  const redirectUri = () => `${location.origin}/player/callback.html`;

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
  const save = (v) => localStorage.setItem(KEY, JSON.stringify(v));
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function playlistUri(input) {
    const s = String(input || '').trim();
    const m = s.match(/playlist[/:]([A-Za-z0-9]+)/);
    return m ? `spotify:playlist:${m[1]}` : null;
  }

  // ---------- autenticação ----------
  async function login(clientId) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
    save({ ...load(), clientId, verifier, state, returnTo: location.href });
    const q = new URLSearchParams({
      response_type: 'code', client_id: clientId, scope: SCOPES,
      redirect_uri: redirectUri(), code_challenge_method: 'S256', code_challenge: challenge, state,
    });
    location.href = `https://accounts.spotify.com/authorize?${q}`;
  }

  async function tokenRequest(params) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.error || 'Falha no login do Spotify');
    const s = load();
    save({
      ...s,
      access_token: data.access_token,
      refresh_token: data.refresh_token || s.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    });
  }

  // chamado pela callback.html
  async function handleCallback() {
    const p = new URLSearchParams(location.search);
    const s = load();
    if (p.get('error')) throw new Error(`Spotify recusou o acesso: ${p.get('error')}`);
    if (!p.get('code') || p.get('state') !== s.state) throw new Error('Retorno do Spotify inválido. Tente conectar de novo.');
    await tokenRequest({
      grant_type: 'authorization_code', code: p.get('code'), redirect_uri: redirectUri(),
      client_id: s.clientId, code_verifier: s.verifier,
    });
    return s.returnTo || '/player/';
  }

  async function getToken() {
    const s = load();
    if (!s.refresh_token) throw new Error('Spotify não conectado');
    if (s.access_token && Date.now() < s.expires_at) return s.access_token;
    await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.clientId });
    return load().access_token;
  }

  const isConnected = () => !!load().refresh_token;
  const disconnect = () => localStorage.removeItem(KEY);

  async function web(method, path, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://api.spotify.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${await getToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 429) { await sleep((Number(res.headers.get('Retry-After')) || 1) * 1000); continue; }
      if (res.status === 404 && attempt < 2) { await sleep(800); continue; } // device ainda não registrado
      if (!res.ok && res.status !== 204) {
        const t = await res.text();
        throw new Error(`Spotify ${res.status}: ${t.slice(0, 200)}`);
      }
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    throw new Error('Spotify não respondeu');
  }

  // ---------- player (Web Playback SDK) ----------
  let player = null;
  let deviceId = null;
  let sdkReady = null;

  function loadSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise((resolve) => {
      window.onSpotifyWebPlaybackSDKReady = resolve;
      const s = document.createElement('script');
      s.src = 'https://sdk.scdn.co/spotify-player.js';
      document.head.appendChild(s);
    });
    return sdkReady;
  }

  async function init(name, onError) {
    await loadSdk();
    if (player) return deviceId;
    player = new window.Spotify.Player({
      name,
      getOAuthToken: (cb) => getToken().then(cb).catch((e) => onError?.(e.message)),
      volume: 1,
    });
    player.addListener('initialization_error', ({ message }) => onError?.(`Navegador sem suporte ao Spotify: ${message}`));
    player.addListener('authentication_error', ({ message }) => onError?.(`Login do Spotify expirou: ${message}`));
    player.addListener('account_error', () => onError?.('A conta do Spotify precisa ser Premium.'));
    player.addListener('playback_error', ({ message }) => console.warn('Spotify playback_error', message));
    player.addListener('not_ready', () => { console.warn('Spotify device offline'); });

    deviceId = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('Spotify não ficou pronto (verifique internet e conta Premium)')), 20000);
      player.addListener('ready', ({ device_id }) => { clearTimeout(to); resolve(device_id); });
      player.connect();
    });
    return deviceId;
  }

  async function start(playlist, shuffle = true) {
    const uri = playlistUri(playlist);
    if (!uri) throw new Error('Link de playlist do Spotify inválido');
    await web('PUT', '/me/player', { device_ids: [deviceId], play: false });
    await sleep(500);
    await web('PUT', `/me/player/shuffle?state=${shuffle}&device_id=${deviceId}`).catch(() => {});
    await web('PUT', `/me/player/play?device_id=${deviceId}`, { context_uri: uri });
    await web('PUT', `/me/player/repeat?state=context&device_id=${deviceId}`).catch(() => {});
  }

  // Reassume o controle se o Spotify foi aberto em outro aparelho
  async function reclaim() {
    await web('PUT', '/me/player', { device_ids: [deviceId], play: true });
  }

  window.RSpotify = {
    playlistUri, login, handleCallback, isConnected, disconnect, init, start, reclaim,
    activate: () => player?.activateElement?.(),
    state: () => (player ? player.getCurrentState() : Promise.resolve(null)),
    pause: () => player?.pause(),
    resume: () => player?.resume(),
    next: () => player?.nextTrack(),
    setVolume: (v) => player?.setVolume(Math.max(0, Math.min(1, v))),
  };
})();
