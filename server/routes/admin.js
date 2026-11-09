import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import { db } from '../db.js';
import { requireAdmin } from '../auth.js';
import { UPLOAD_DIR } from '../paths.js';

const r = Router();
r.use(requireAdmin);

const now = () => Date.now();
const newToken = () => crypto.randomBytes(18).toString('base64url');
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.flac', '.webm', '.mpeg', '.mpga']);
// .mpeg/.mpga de áudio são MP3 com outra extensão: salvamos como .mp3 para o navegador reconhecer
const EXT_ALIAS = { '.mpeg': '.mp3', '.mpga': '.mp3' };

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- Empresas ----------
r.get('/companies', wrap(async (_req, res) => {
  res.json(await db('companies').orderBy('name'));
}));

r.post('/companies', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Informe o nome' });
  const [id] = await db('companies').insert({ name, created_at: now() });
  res.json(await db('companies').where({ id }).first());
}));

r.put('/companies/:id', wrap(async (req, res) => {
  await db('companies').where({ id: req.params.id }).update({ name: String(req.body.name || '').trim() });
  res.json({ ok: true });
}));

r.delete('/companies/:id', wrap(async (req, res) => {
  const files = await db('media').where({ company_id: req.params.id }).pluck('filename');
  await db('companies').where({ id: req.params.id }).del();
  files.forEach(removeFile);
  res.json({ ok: true });
}));

// ---------- Unidades (players) ----------
r.get('/units', wrap(async (req, res) => {
  const q = db('units').orderBy('name');
  if (req.query.company_id) q.where({ company_id: req.query.company_id });
  const units = await q;
  res.json(units.map(formatUnit));
}));

r.post('/units', wrap(async (req, res) => {
  const { company_id, name, playlist_id } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: 'Informe empresa e nome' });
  const [id] = await db('units').insert({
    company_id, name: String(name).trim(), playlist_id: playlist_id || null,
    token: newToken(), volume: 100, created_at: now(),
  });
  res.json(formatUnit(await db('units').where({ id }).first()));
}));

r.put('/units/:id', wrap(async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body.playlist_id !== undefined) patch.playlist_id = req.body.playlist_id || null;
  if (req.body.volume !== undefined) patch.volume = Math.max(0, Math.min(100, Number(req.body.volume)));
  if (req.body.music_source !== undefined) patch.music_source = req.body.music_source === 'spotify' ? 'spotify' : 'library';
  if (req.body.spotify_playlist !== undefined) patch.spotify_playlist = String(req.body.spotify_playlist).trim() || null;
  await db('units').where({ id: req.params.id }).update(patch);
  res.json({ ok: true });
}));

r.post('/units/:id/token', wrap(async (req, res) => {
  const token = newToken();
  await db('units').where({ id: req.params.id }).update({ token });
  res.json({ token });
}));

r.delete('/units/:id', wrap(async (req, res) => {
  await db('units').where({ id: req.params.id }).del();
  res.json({ ok: true });
}));

// ---------- Biblioteca de áudios ----------
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${crypto.randomUUID()}${EXT_ALIAS[ext] || ext}`);
    },
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 80) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, AUDIO_EXT.has(ext) || file.mimetype.startsWith('audio/'));
  },
});

r.get('/media', wrap(async (req, res) => {
  const q = db('media').orderBy('created_at', 'desc');
  if (req.query.company_id) q.where({ company_id: req.query.company_id });
  if (req.query.kind) q.where({ kind: req.query.kind });
  res.json((await q).map(formatMedia));
}));

r.post('/media/upload', upload.array('files', 50), wrap(async (req, res) => {
  const { company_id, kind = 'music', queue_unit_id, queue_mode } = req.body;
  const files = req.files || [];
  if (!company_id) {
    files.forEach((f) => removeFile(f.filename));
    return res.status(400).json({ error: 'Informe a empresa' });
  }
  if (!files.length) return res.status(400).json({ error: 'Nenhum arquivo de áudio válido' });

  const created = [];
  for (const f of files) {
    const original = Buffer.from(f.originalname, 'latin1').toString('utf8');
    let title = path.basename(original, path.extname(original));
    let artist = null;
    let duration = null;
    try {
      const meta = await parseFile(f.path, { duration: true });
      duration = meta.format.duration || null;
      if (meta.common.title) title = meta.common.title;
      if (meta.common.artist) artist = meta.common.artist;
    } catch { /* metadados opcionais */ }

    const [id] = await db('media').insert({
      company_id, kind: kind === 'spot' ? 'spot' : 'music', title, artist,
      filename: f.filename, mime: f.mimetype, duration, size: f.size, created_at: now(),
    });
    created.push(formatMedia(await db('media').where({ id }).first()));
  }

  // Upload direto para a fila ao vivo de uma unidade
  if (queue_unit_id) {
    for (const m of created) {
      await db('queue').insert({
        unit_id: queue_unit_id, media_id: m.id,
        mode: queue_mode === 'now' ? 'now' : 'next', status: 'pending', created_at: now(),
      });
    }
  }
  res.json(created);
}));

r.put('/media/:id', wrap(async (req, res) => {
  const patch = {};
  for (const k of ['title', 'artist']) if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
  if (req.body.kind) patch.kind = req.body.kind === 'spot' ? 'spot' : 'music';
  await db('media').where({ id: req.params.id }).update(patch);
  res.json({ ok: true });
}));

r.delete('/media/:id', wrap(async (req, res) => {
  const m = await db('media').where({ id: req.params.id }).first();
  if (!m) return res.json({ ok: true });
  await db('media').where({ id: m.id }).del();
  removeFile(m.filename);
  res.json({ ok: true });
}));

// ---------- Playlists ----------
r.get('/playlists', wrap(async (req, res) => {
  const q = db('playlists')
    .leftJoin('playlist_items', 'playlist_items.playlist_id', 'playlists.id')
    .leftJoin('media', 'media.id', 'playlist_items.media_id')
    .groupBy('playlists.id', 'playlists.company_id', 'playlists.name', 'playlists.shuffle', 'playlists.created_at')
    .select('playlists.*')
    .count({ tracks: 'playlist_items.id' })
    .sum({ total_duration: 'media.duration' })
    .orderBy('playlists.name');
  if (req.query.company_id) q.where('playlists.company_id', req.query.company_id);
  res.json(await q);
}));

r.post('/playlists', wrap(async (req, res) => {
  const { company_id, name } = req.body;
  if (!company_id || !name) return res.status(400).json({ error: 'Informe empresa e nome' });
  const [id] = await db('playlists').insert({ company_id, name: String(name).trim(), shuffle: true, created_at: now() });
  res.json(await db('playlists').where({ id }).first());
}));

r.put('/playlists/:id', wrap(async (req, res) => {
  const patch = {};
  if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
  if (req.body.shuffle !== undefined) patch.shuffle = !!req.body.shuffle;
  await db('playlists').where({ id: req.params.id }).update(patch);
  res.json({ ok: true });
}));

r.delete('/playlists/:id', wrap(async (req, res) => {
  await db('playlists').where({ id: req.params.id }).del();
  res.json({ ok: true });
}));

r.get('/playlists/:id/items', wrap(async (req, res) => {
  const rows = await db('playlist_items')
    .join('media', 'media.id', 'playlist_items.media_id')
    .where('playlist_items.playlist_id', req.params.id)
    .orderBy('playlist_items.position')
    .select('media.*', 'playlist_items.id as item_id');
  res.json(rows.map((m) => ({ ...formatMedia(m), item_id: m.item_id })));
}));

// Substitui a lista inteira (ordem incluída)
r.put('/playlists/:id/items', wrap(async (req, res) => {
  const ids = (req.body.media_ids || []).map(Number).filter(Boolean);
  await db.transaction(async (trx) => {
    await trx('playlist_items').where({ playlist_id: req.params.id }).del();
    if (ids.length) {
      await trx('playlist_items').insert(ids.map((media_id, i) => ({ playlist_id: req.params.id, media_id, position: i })));
    }
  });
  res.json({ ok: true });
}));

// Adiciona ao final
r.post('/playlists/:id/items', wrap(async (req, res) => {
  const ids = (req.body.media_ids || []).map(Number).filter(Boolean);
  const max = await db('playlist_items').where({ playlist_id: req.params.id }).max({ m: 'position' }).first();
  let pos = (max?.m ?? -1) + 1;
  const existing = new Set(await db('playlist_items').where({ playlist_id: req.params.id }).pluck('media_id'));
  const rows = ids.filter((id) => !existing.has(id)).map((media_id) => ({ playlist_id: req.params.id, media_id, position: pos++ }));
  if (rows.length) await db('playlist_items').insert(rows);
  res.json({ added: rows.length });
}));

// ---------- Campanhas de spots ----------
const CAMPAIGN_FIELDS = ['company_id', 'unit_id', 'media_id', 'name', 'mode', 'interval_value', 'fixed_times',
  'start_date', 'end_date', 'days', 'hour_start', 'hour_end', 'priority', 'active', 'all_spots', 'per_break'];

function campaignPatch(body) {
  const p = {};
  for (const k of CAMPAIGN_FIELDS) if (body[k] !== undefined) p[k] = body[k] === '' ? null : body[k];
  if (p.mode && !['tracks', 'minutes', 'times'].includes(p.mode)) p.mode = 'tracks';
  if (p.interval_value != null) p.interval_value = Math.max(1, Number(p.interval_value) || 1);
  if (p.active !== undefined) p.active = !!p.active;
  if (p.all_spots !== undefined) p.all_spots = !!p.all_spots;
  if (p.all_spots) p.media_id = null;
  if (p.per_break != null) p.per_break = Math.max(0, Number(p.per_break) || 0);
  return p;
}

r.get('/campaigns', wrap(async (req, res) => {
  const q = db('campaigns')
    .leftJoin('media', 'media.id', 'campaigns.media_id')
    .leftJoin('units', 'units.id', 'campaigns.unit_id')
    .select('campaigns.*', 'media.title as media_title', 'media.duration as media_duration', 'units.name as unit_name')
    .orderBy('campaigns.created_at', 'desc');
  if (req.query.company_id) q.where('campaigns.company_id', req.query.company_id);
  res.json(await q);
}));

r.post('/campaigns', wrap(async (req, res) => {
  const p = campaignPatch(req.body);
  if (!p.company_id || (!p.media_id && !p.all_spots) || !p.name || !p.mode) return res.status(400).json({ error: 'Preencha nome, spot e regra' });
  const [id] = await db('campaigns').insert({ active: true, ...p, created_at: now() });
  res.json(await db('campaigns').where({ id }).first());
}));

r.put('/campaigns/:id', wrap(async (req, res) => {
  await db('campaigns').where({ id: req.params.id }).update(campaignPatch(req.body));
  res.json({ ok: true });
}));

r.delete('/campaigns/:id', wrap(async (req, res) => {
  await db('campaigns').where({ id: req.params.id }).del();
  res.json({ ok: true });
}));

// ---------- Ao vivo: fila e comandos ----------
r.get('/units/:id/live', wrap(async (req, res) => {
  const unit = await db('units').where({ id: req.params.id }).first();
  if (!unit) return res.status(404).json({ error: 'Unidade não encontrada' });
  const queue = await db('queue')
    .join('media', 'media.id', 'queue.media_id')
    .where('queue.unit_id', unit.id)
    .whereIn('queue.status', ['pending', 'playing'])
    .orderBy('queue.id')
    .select('queue.id', 'queue.mode', 'queue.status', 'queue.created_at', 'media.title', 'media.kind', 'media.duration');
  const recent = await db('play_logs').where({ unit_id: unit.id }).orderBy('played_at', 'desc').limit(15);
  res.json({ unit: formatUnit(unit), queue, recent });
}));

r.post('/units/:id/queue', wrap(async (req, res) => {
  const ids = [].concat(req.body.media_ids || req.body.media_id || []).map(Number).filter(Boolean);
  const mode = req.body.mode === 'now' ? 'now' : 'next';
  for (const media_id of ids) {
    await db('queue').insert({ unit_id: req.params.id, media_id, mode, status: 'pending', created_at: now() });
  }
  res.json({ ok: true, added: ids.length });
}));

r.delete('/queue/:id', wrap(async (req, res) => {
  await db('queue').where({ id: req.params.id }).whereIn('status', ['pending']).update({ status: 'canceled' });
  res.json({ ok: true });
}));

r.post('/units/:id/command', wrap(async (req, res) => {
  const cmd = String(req.body.cmd || '');
  if (!['skip', 'pause', 'resume', 'volume', 'reload'].includes(cmd)) return res.status(400).json({ error: 'Comando inválido' });
  const value = req.body.value != null ? String(req.body.value) : null;
  if (cmd === 'volume') await db('units').where({ id: req.params.id }).update({ volume: Number(value) });
  await db('commands').insert({ unit_id: req.params.id, cmd, value, status: 'pending', created_at: now() });
  res.json({ ok: true });
}));

// ---------- Relatório de veiculação ----------
r.get('/logs', wrap(async (req, res) => {
  const q = db('play_logs')
    .join('units', 'units.id', 'play_logs.unit_id')
    .select('play_logs.*', 'units.name as unit_name')
    .orderBy('play_logs.played_at', 'desc');
  if (req.query.company_id) q.where('units.company_id', req.query.company_id);
  if (req.query.unit_id) q.where('play_logs.unit_id', req.query.unit_id);
  if (req.query.kind) q.where('play_logs.kind', req.query.kind);
  if (req.query.from) q.where('play_logs.played_at', '>=', new Date(`${req.query.from}T00:00:00`).getTime());
  if (req.query.to) q.where('play_logs.played_at', '<=', new Date(`${req.query.to}T23:59:59`).getTime());
  const rows = await q.limit(req.query.format === 'csv' ? 100000 : 500);

  if (req.query.format === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = ['Data/hora;Unidade;Tipo;Título;Origem'];
    for (const l of rows) {
      lines.push([new Date(Number(l.played_at)).toLocaleString('pt-BR'), l.unit_name, l.kind, l.title, l.source].map(esc).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="veiculacao.csv"');
    return res.send('﻿' + lines.join('\n'));
  }
  res.json(rows);
}));

// ---------- helpers ----------
function formatMedia(m) {
  return { ...m, url: `/media/${m.filename}` };
}

function formatUnit(u) {
  let status = null;
  try { status = u.status_json ? JSON.parse(u.status_json) : null; } catch { /* */ }
  const online = !!u.last_seen && Date.now() - Number(u.last_seen) < 45000;
  const { status_json, ...rest } = u;
  return { ...rest, status, online };
}

function removeFile(filename) {
  if (!filename) return;
  fs.unlink(path.join(UPLOAD_DIR, path.basename(filename)), () => {});
}

export default r;
