import crypto from 'node:crypto';

const COOKIE = 'rs_session';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

function secret() {
  return process.env.SESSION_SECRET || 'dev-secret-troque-no-env';
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function login(req, res) {
  const { user, password } = req.body || {};
  const okUser = safeEqual(user || '', process.env.ADMIN_USER || 'admin');
  const okPass = safeEqual(password || '', process.env.ADMIN_PASSWORD || 'admin');
  if (!okUser || !okPass) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const token = sign({ u: user, exp: Date.now() + MAX_AGE_MS });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? '; Secure' : ''}`
  );
  res.json({ ok: true });
}

export function logout(_req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

export function requireAdmin(req, res, next) {
  const data = verify(readCookie(req, COOKIE));
  if (!data) return res.status(401).json({ error: 'Não autenticado' });
  req.admin = data;
  next();
}

export function isAdmin(req) {
  return !!verify(readCookie(req, COOKIE));
}
