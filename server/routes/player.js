import { Router } from 'express';
import { db } from '../db.js';

const r = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Autentica o player pelo token da unidade (?t=...)
r.use(wrap(async (req, res, next) => {
  const token = req.query.t || req.headers['x-unit-token'];
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  const unit = await db('units').where({ token }).first();
  if (!unit) return res.status(401).json({ error: 'Token inválido' });
  req.unit = unit;
  next();
}));

const mediaOut = (m) => ({
  id: m.id, kind: m.kind, title: m.title, artist: m.artist,
  duration: m.duration, url: `/media/${m.filename}`,
});

// Configuração completa da unidade. O player chama a cada poucos segundos;
// o Express gera ETag, então sem mudanças a resposta é um 304 vazio.
r.get('/sync', wrap(async (req, res) => {
  const unit = req.unit;
  const company = await db('companies').where({ id: unit.company_id }).first();

  let playlist = null;
  if (unit.playlist_id) {
    const pl = await db('playlists').where({ id: unit.playlist_id }).first();
    if (pl) {
      const tracks = await db('playlist_items')
        .join('media', 'media.id', 'playlist_items.media_id')
        .where('playlist_items.playlist_id', pl.id)
        .orderBy('playlist_items.position')
        .select('media.*');
      playlist = { id: pl.id, name: pl.name, shuffle: !!pl.shuffle, tracks: tracks.map(mediaOut) };
    }
  }

  // Margem de 1 dia por causa de fuso horário; o player aplica a data exata localmente
  const today = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const campaigns = await db('campaigns')
    .leftJoin('media', 'media.id', 'campaigns.media_id')
    .where('campaigns.company_id', unit.company_id)
    .where('campaigns.active', true)
    .where((q) => q.whereNull('campaigns.unit_id').orWhere('campaigns.unit_id', unit.id))
    .where((q) => q.whereNull('campaigns.end_date').orWhere('campaigns.end_date', '>=', today))
    .select('campaigns.*', 'media.id as m_id', 'media.kind as m_kind', 'media.title as m_title',
      'media.artist as m_artist', 'media.duration as m_duration', 'media.filename as m_filename');

  // Rodízio: todos os spots da empresa, em ordem de envio
  const pool = campaigns.some((c) => c.all_spots)
    ? (await db('media').where({ company_id: unit.company_id, kind: 'spot' }).orderBy('id')).map(mediaOut)
    : [];

  const queue = await db('queue')
    .join('media', 'media.id', 'queue.media_id')
    .where('queue.unit_id', unit.id)
    .where('queue.status', 'pending')
    .orderBy('queue.id')
    .select('queue.id as q_id', 'queue.mode as q_mode', 'media.*');

  const commands = await db('commands').where({ unit_id: unit.id, status: 'pending' }).orderBy('id');

  res.json({
    unit: {
      id: unit.id, name: unit.name, volume: unit.volume, company: company?.name,
      music_source: unit.music_source || 'library',
      spotify_playlist: unit.spotify_playlist || null,
      spotify_client_id: process.env.SPOTIFY_CLIENT_ID || null,
    },
    playlist,
    campaigns: campaigns.filter((c) => (c.all_spots ? pool.length : c.m_id)).map((c) => ({
      id: c.id, name: c.name, mode: c.mode, interval_value: c.interval_value,
      fixed_times: c.fixed_times, start_date: c.start_date, end_date: c.end_date,
      days: c.days, hour_start: c.hour_start, hour_end: c.hour_end, priority: c.priority,
      per_break: c.per_break ?? 1,
      pool: c.all_spots ? pool : null,
      media: c.all_spots ? pool[0] : mediaOut({ id: c.m_id, kind: c.m_kind, title: c.m_title, artist: c.m_artist, duration: c.m_duration, filename: c.m_filename }),
    })),
    queue: queue.map((q) => ({ id: q.q_id, mode: q.q_mode, media: mediaOut(q) })),
    commands: commands.map((c) => ({ id: c.id, cmd: c.cmd, value: c.value })),
  });
}));

// Player confirma itens da fila iniciados/terminados e comandos executados
r.post('/ack', wrap(async (req, res) => {
  const { queue_playing = [], queue_done = [], commands_done = [] } = req.body || {};
  const uid = req.unit.id;
  if (queue_playing.length) {
    await db('queue').where({ unit_id: uid }).whereIn('id', queue_playing).where('status', 'pending')
      .update({ status: 'playing', played_at: Date.now() });
  }
  if (queue_done.length) {
    await db('queue').where({ unit_id: uid }).whereIn('id', queue_done).update({ status: 'done' });
  }
  if (commands_done.length) {
    await db('commands').where({ unit_id: uid }).whereIn('id', commands_done).update({ status: 'done' });
  }
  res.json({ ok: true });
}));

// Batimento: status atual + logs de veiculação (inclusive os acumulados offline)
r.post('/heartbeat', wrap(async (req, res) => {
  const { status = null, logs = [] } = req.body || {};
  await db('units').where({ id: req.unit.id }).update({
    last_seen: Date.now(),
    status_json: status ? JSON.stringify(status).slice(0, 4000) : null,
  });
  const rows = (Array.isArray(logs) ? logs : []).slice(0, 500).map((l) => ({
    unit_id: req.unit.id,
    media_id: Number(l.media_id) || null,
    kind: l.kind === 'spot' ? 'spot' : 'music',
    title: String(l.title || '').slice(0, 255),
    source: String(l.source || '').slice(0, 20),
    campaign_id: Number(l.campaign_id) || null,
    played_at: Number(l.played_at) || Date.now(),
    client_ref: String(l.ref || '').slice(0, 40) || null,
  }));
  if (rows.length) await db('play_logs').insert(rows).onConflict('client_ref').ignore();
  res.json({ ok: true, saved: rows.length });
}));

export default r;
