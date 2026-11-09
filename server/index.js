import 'dotenv/config';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, migrate } from './db.js';
import { login, logout, requireAdmin, isAdmin } from './auth.js';
import { UPLOAD_DIR } from './paths.js';
import adminRoutes from './routes/admin.js';
import playerRoutes from './routes/player.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// Arquivos de áudio: acessíveis ao painel (cookie) ou ao player (token da unidade)
app.use('/media', async (req, res, next) => {
  try {
    if (isAdmin(req)) return next();
    const token = req.query.t;
    if (token && (await db('units').where({ token }).first())) return next();
    res.status(401).end();
  } catch (e) { next(e); }
}, express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));

app.post('/api/login', login);
app.post('/api/logout', logout);
app.get('/api/me', requireAdmin, (req, res) => res.json({ user: req.admin.u }));
app.use('/api/player', playerRoutes);
app.use('/api', adminRoutes);

app.use('/player', express.static(path.join(PUBLIC, 'player'), { maxAge: 0 }));
app.use('/', express.static(path.join(PUBLIC, 'admin'), { maxAge: 0 }));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Arquivo maior que o limite permitido' });
  res.status(500).json({ error: 'Erro interno', detail: err?.message });
});

const port = Number(process.env.PORT || 3000);
migrate()
  .then(() => {
    app.listen(port, () => console.log(`Rádio Siran rodando em http://localhost:${port}`));
  })
  .catch((e) => {
    console.error('Falha ao preparar o banco de dados:', e);
    process.exit(1);
  });
