import express from 'express';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import sharp from 'sharp';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = process.env.STORAGE_DIR || '/data/files';
const NAS_DIR = path.resolve(process.env.NAS_DIR || '/data/nas');
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR || '/tmp/arca-drive-thumbnails';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 200) * 1024 * 1024;
const MAX_UPLOAD_CHUNK = Number(process.env.MAX_UPLOAD_CHUNK_MB || 10) * 1024 * 1024;
const ACCESS_TOKEN_MINUTES = Number(process.env.ACCESS_TOKEN_MINUTES || 15);
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const TOTP_KEY = crypto.createHash('sha256').update(process.env.TOTP_ENCRYPTION_KEY || `arca-drive-totp:${JWT_SECRET}`).digest();
const COLLABORA_INTERNAL_URL = String(process.env.COLLABORA_INTERNAL_URL || 'http://collabora:9980').replace(/\/$/, '');
const WOPI_INTERNAL_URL = String(process.env.WOPI_INTERNAL_URL || 'http://app:3000').replace(/\/$/, '');
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
if (!DATABASE_URL && !process.env.PGHOST) throw new Error('Database configuration is required');

await fs.mkdir(STORAGE_DIR, { recursive: true });
await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL })
  : new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD
    });
const schema = await fs.readFile(path.join(__dirname, 'db/schema.sql'), 'utf8');

for (let attempt = 1; attempt <= 30; attempt++) {
  try {
    await pool.query(schema);
    break;
  } catch (error) {
    if (attempt === 30) throw error;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

const expiredUploads = await pool.query("DELETE FROM upload_sessions WHERE expires_at<=now() RETURNING storage_name");
await Promise.all(expiredUploads.rows.map(row => fs.unlink(path.join(STORAGE_DIR, row.storage_name)).catch(() => {})));
await pool.query("DELETE FROM device_sessions WHERE expires_at<=now() OR revoked_at<now()-interval '30 days'");
await pool.query('DELETE FROM wopi_locks WHERE expires_at<=now()');
await pool.query("DELETE FROM two_factor_challenges WHERE expires_at<=now() OR used_at<now()-interval '1 day'");
await pool.query(
  `UPDATE entries candidate SET is_system=true
   WHERE candidate.id IN (
     SELECT DISTINCT ON (owner_id) id
     FROM entries
     WHERE name='Immagini' AND kind='folder' AND parent_id IS NULL AND is_trashed=false
     ORDER BY owner_id,created_at
   )
   AND NOT EXISTS (
     SELECT 1 FROM entries system_folder
     WHERE system_folder.owner_id=candidate.owner_id AND system_folder.is_system=true
       AND system_folder.name='Immagini' AND system_folder.parent_id IS NULL
   )`
);
await pool.query(
  `INSERT INTO entries(owner_id,name,kind,is_system)
   SELECT id,'Immagini','folder',true FROM users
   ON CONFLICT (owner_id) WHERE is_system=true AND name='Immagini' AND parent_id IS NULL DO NOTHING`
);

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (process.env.REQUIRE_HTTPS === 'true' && !req.secure && req.path !== '/health') {
    return res.status(426).json({ error: 'HTTPS richiesto' });
  }
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

function accessTokenFor(user, sessionId) {
  return jwt.sign(
    { sub: user.id, sid: sessionId, role: user.role, email: user.email, typ: 'access' },
    JWT_SECRET,
    { expiresIn: `${ACCESS_TOKEN_MINUTES}m` }
  );
}

function hashToken(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encryptTotpSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', TOTP_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptTotpSecret(value) {
  const [iv, tag, ciphertext] = String(value || '').split('.');
  if (!iv || !tag || !ciphertext) throw new Error('Configurazione 2FA non valida');
  const decipher = crypto.createDecipheriv('aes-256-gcm', TOTP_KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

function totpFor(user, secret) {
  return new OTPAuth.TOTP({
    issuer: 'Arca Drive',
    label: user.email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret)
  });
}

function normalizeSecondFactorCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[\s-]/g, '');
}

function recoveryCodeHash(value) {
  return crypto.createHmac('sha256', JWT_SECRET).update(normalizeSecondFactorCode(value)).digest('hex');
}

async function verifySecondFactor(user, value, db = pool) {
  const normalized = normalizeSecondFactorCode(value);
  if (/^\d{6}$/.test(normalized) && user.totp_secret_encrypted) {
    const secret = decryptTotpSecret(user.totp_secret_encrypted);
    if (totpFor(user, secret).validate({ token: normalized, window: 1 }) !== null) return true;
  }
  if (!/^[A-F0-9]{10}$/.test(normalized)) return false;
  const result = await db.query(
    `UPDATE two_factor_recovery_codes SET used_at=now()
     WHERE id=(SELECT id FROM two_factor_recovery_codes WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL LIMIT 1)
     RETURNING id`,
    [user.id, recoveryCodeHash(normalized)]
  );
  return result.rowCount > 0;
}

function generateRecoveryCodes() {
  return Array.from({ length: 10 }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

async function replaceRecoveryCodes(userId, db = pool) {
  const codes = generateRecoveryCodes();
  await db.query('DELETE FROM two_factor_recovery_codes WHERE user_id=$1', [userId]);
  for (const code of codes) {
    await db.query('INSERT INTO two_factor_recovery_codes(user_id,code_hash) VALUES($1,$2)', [userId, recoveryCodeHash(code)]);
  }
  return codes;
}

async function createSession(user, req, device = {}) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
  const { rows } = await pool.query(
    `INSERT INTO device_sessions(user_id,refresh_token_hash,device_name,platform,last_ip,user_agent,expires_at)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [
      user.id,
      hashToken(refreshToken),
      cleanName(device.deviceName || 'Browser web'),
      String(device.platform || 'web').slice(0, 40),
      req.ip,
      String(req.headers['user-agent'] || '').slice(0, 500),
      expiresAt
    ]
  );
  const accessToken = accessTokenFor(user, rows[0].id);
  return {
    token: accessToken,
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_MINUTES * 60,
    user
  };
}

async function auth(req, res, next) {
  const value = req.headers.authorization || '';
  try {
    req.user = jwt.verify(value.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    if (req.user.typ !== 'access') throw new Error('Invalid token type');
    const { rowCount } = await pool.query(
      'SELECT 1 FROM device_sessions WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()',
      [req.user.sid, req.user.sub]
    );
    if (!rowCount) throw new Error('Revoked session');
    next();
  } catch {
    res.status(401).json({ error: 'Sessione non valida o scaduta' });
  }
}

function admin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Permesso amministratore richiesto' });
  next();
}

function writable(req, res, next) {
  if (req.user.role === 'viewer') return res.status(403).json({ error: 'Account in sola lettura' });
  next();
}

function cleanName(value) {
  const name = String(value || '').trim().replace(/[\\/\0]/g, '_');
  if (!name || name.length > 255) throw new Error('Nome non valido');
  return name;
}

function nasRelative(value = '') {
  const raw = String(value || '').replaceAll('\\', '/');
  if (raw.includes('\0') || path.posix.isAbsolute(raw)) throw new Error('Percorso NAS non valido');
  const normalized = path.posix.normalize(`/${raw}`).slice(1);
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('Percorso NAS non valido');
  return normalized === '.' ? '' : normalized;
}

function isInside(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

async function nasRoot() {
  try {
    const root = await fs.realpath(NAS_DIR);
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error();
    return root;
  } catch {
    const error = new Error('NAS non disponibile: controlla il montaggio /data/nas');
    error.status = 503;
    throw error;
  }
}

async function existingNasPath(value = '') {
  const root = await nasRoot();
  const relative = nasRelative(value);
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) throw new Error('Percorso NAS non valido');
  const real = await fs.realpath(candidate);
  if (!isInside(root, real)) throw new Error('Percorso NAS non valido');
  return { root, real, relative };
}

async function newNasPath(parentValue, nameValue) {
  const parent = await existingNasPath(parentValue);
  const name = cleanName(nameValue);
  const target = path.join(parent.real, name);
  if (!isInside(parent.root, target)) throw new Error('Percorso NAS non valido');
  return { ...parent, name, target, childRelative: parent.relative ? `${parent.relative}/${name}` : name };
}

function nasMime(name) {
  const extension = officeExtension(name);
  return ({
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', txt: 'text/plain', csv: 'text/csv',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp4: 'video/mp4', mp3: 'audio/mpeg', zip: 'application/zip'
  })[extension] || 'application/octet-stream';
}

async function sendThumbnail(sourcePath, cacheIdentity, res) {
  const cacheName = `${crypto.createHash('sha256').update(cacheIdentity).digest('hex')}.webp`;
  const destination = path.join(THUMBNAIL_DIR, cacheName);
  try {
    await fs.access(destination);
  } catch {
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
      await sharp(sourcePath, { failOn: 'none' })
        .rotate()
        .resize(192, 192, { fit: 'cover', position: 'centre', withoutEnlargement: true })
        .webp({ quality: 76, effort: 4 })
        .toFile(temporary);
      await fs.rename(temporary, destination).catch(async error => {
        if (error.code !== 'EEXIST') throw error;
        await fs.unlink(temporary).catch(() => {});
      });
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw error;
    }
  }
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type('image/webp');
  res.sendFile(destination);
}

async function ensureImagesFolder(userId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO entries(owner_id,name,kind,is_system)
     VALUES($1,'Immagini','folder',true)
     ON CONFLICT (owner_id) WHERE is_system=true AND name='Immagini' AND parent_id IS NULL
     DO UPDATE SET name=EXCLUDED.name
     RETURNING id`,
    [userId]
  );
  return rows[0].id;
}

function officeExtension(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

function decodeXmlAttribute(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

let discoveryCache = { expiresAt: 0, xml: '' };
async function collaboraActionUrl(extension, publicUrl, wopiSource) {
  if (discoveryCache.expiresAt <= Date.now()) {
    const response = await fetch(`${COLLABORA_INTERNAL_URL}/hosting/discovery`);
    if (!response.ok) throw new Error('Collabora CODE non è disponibile');
    discoveryCache = { xml: await response.text(), expiresAt: Date.now() + 5 * 60 * 1000 };
  }
  const actions = discoveryCache.xml.match(/<action\b[^>]*>/g) || [];
  const candidates = actions.map(tag => Object.fromEntries(
    [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], decodeXmlAttribute(match[2])])
  ));
  const action = candidates.find(item => item.ext === extension && item.name === 'edit')
    || candidates.find(item => item.ext === extension && item.name === 'view');
  if (!action?.urlsrc) throw new Error('Formato non supportato da Collabora CODE');
  const cleanUrl = action.urlsrc.replace(/<[^>]+>/g, '');
  const internalAction = new URL(cleanUrl);
  const externalBase = new URL(publicUrl);
  internalAction.protocol = externalBase.protocol;
  internalAction.host = externalBase.host;
  internalAction.searchParams.set('WOPISrc', wopiSource);
  return internalAction.toString();
}

function wopiToken(req, res, next) {
  try {
    const payload = jwt.verify(String(req.query.access_token || ''), JWT_SECRET);
    if (payload.typ !== 'wopi' || payload.entryId !== req.params.id) throw new Error('Token WOPI non valido');
    req.wopi = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token WOPI non valido o scaduto' });
  }
}

async function recordChange(db, entryId, action, payload = {}) {
  await db.query(
    `INSERT INTO changes(user_id,entry_id,action,payload)
     SELECT recipients.user_id,$1,$2,$3::jsonb
     FROM (
       SELECT owner_id AS user_id FROM entries WHERE id=$1
       UNION
       SELECT user_id FROM shares WHERE entry_id=$1
     ) recipients`,
    [entryId, action, JSON.stringify(payload)]
  );
}

async function canAccess(entryId, userId, edit = false) {
  const { rows } = await pool.query(
    `SELECT e.*, (e.owner_id = $2 OR u.role = 'admin' OR s.permission = 'edit' OR ($3 = false AND s.permission = 'view')) AS allowed
     FROM entries e
     CROSS JOIN users u
     LEFT JOIN shares s ON s.entry_id = e.id AND s.user_id = $2
     WHERE e.id = $1 AND u.id = $2`,
    [entryId, userId, edit]
  );
  return rows[0]?.allowed ? rows[0] : null;
}

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});

app.get('/api/setup/status', async (_req, res) => {
  const { rows } = await pool.query('SELECT EXISTS(SELECT 1 FROM users) AS configured');
  res.json(rows[0]);
});

app.post('/api/setup', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE users IN EXCLUSIVE MODE');
    const existing = await client.query('SELECT EXISTS(SELECT 1 FROM users) AS configured');
    if (existing.rows[0].configured) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Configurazione iniziale già completata' });
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = cleanName(req.body.name);
    const password = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) throw new Error('Email non valida o password inferiore a 10 caratteri');
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await client.query(
      'INSERT INTO users(email, name, password_hash, role) VALUES($1,$2,$3,\'admin\') RETURNING id,email,name,role',
      [email, name, hash]
    );
    await client.query('COMMIT');
    await ensureImagesFolder(rows[0].id);
    res.status(201).json(await createSession(rows[0], req, req.body));
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Email o password non corretti' });
  }
  const safe = { id: user.id, email: user.email, name: user.name, role: user.role };
  if (user.totp_enabled) {
    const device = {
      deviceName: String(req.body.deviceName || 'Browser web').slice(0, 255),
      platform: String(req.body.platform || 'web').slice(0, 40)
    };
    const { rows: challengeRows } = await pool.query(
      `INSERT INTO two_factor_challenges(user_id,device,expires_at)
       VALUES($1,$2::jsonb,now()+interval '5 minutes') RETURNING id,expires_at`,
      [user.id, JSON.stringify(device)]
    );
    const challengeToken = jwt.sign(
      { typ: '2fa_login', sub: user.id, cid: challengeRows[0].id },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    return res.status(202).json({ requiresTwoFactor: true, challengeToken, expiresIn: 300 });
  }
  res.json(await createSession(safe, req, req.body));
});

app.post('/api/auth/2fa', async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.body.challengeToken || ''), JWT_SECRET);
    if (payload.typ !== '2fa_login') throw new Error('Tipo token non valido');
  } catch {
    return res.status(401).json({ error: 'Verifica scaduta: accedi nuovamente' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT c.*,u.email,u.name,u.role,u.totp_enabled,u.totp_secret_encrypted
       FROM two_factor_challenges c JOIN users u ON u.id=c.user_id
       WHERE c.id=$1 AND c.user_id=$2 FOR UPDATE`,
      [payload.cid, payload.sub]
    );
    const challenge = rows[0];
    if (!challenge || challenge.used_at || new Date(challenge.expires_at) <= new Date() || challenge.attempts >= 5 || !challenge.totp_enabled) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Verifica scaduta: accedi nuovamente' });
    }
    await client.query('UPDATE two_factor_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
    const valid = await verifySecondFactor({
      id: challenge.user_id,
      email: challenge.email,
      totp_secret_encrypted: challenge.totp_secret_encrypted
    }, req.body.code, client);
    if (!valid) {
      await client.query('COMMIT');
      return res.status(401).json({ error: 'Codice di verifica non valido' });
    }
    await client.query('UPDATE two_factor_challenges SET used_at=now() WHERE id=$1', [challenge.id]);
    await client.query('COMMIT');
    const safe = { id: challenge.user_id, email: challenge.email, name: challenge.name, role: challenge.role };
    res.json(await createSession(safe, req, challenge.device));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/auth/refresh', async (req, res) => {
  const refreshToken = String(req.body.refreshToken || '');
  if (!refreshToken) return res.status(400).json({ error: 'Refresh token richiesto' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT ds.*,u.email,u.name,u.role
       FROM device_sessions ds JOIN users u ON u.id=ds.user_id
       WHERE ds.refresh_token_hash=$1 AND ds.revoked_at IS NULL AND ds.expires_at>now()
       FOR UPDATE`,
      [hashToken(refreshToken)]
    );
    const session = rows[0];
    if (!session) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Sessione non valida o scaduta' });
    }
    const nextRefreshToken = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 86400000);
    await client.query(
      `UPDATE device_sessions SET refresh_token_hash=$1,last_used_at=now(),last_ip=$2,user_agent=$3,expires_at=$4 WHERE id=$5`,
      [hashToken(nextRefreshToken), req.ip, String(req.headers['user-agent'] || '').slice(0, 500), expiresAt, session.id]
    );
    await client.query('COMMIT');
    const safe = { id: session.user_id, email: session.email, name: session.name, role: session.role };
    const accessToken = accessTokenFor(safe, session.id);
    res.json({ token: accessToken, accessToken, refreshToken: nextRefreshToken, expiresIn: ACCESS_TOKEN_MINUTES * 60, user: safe });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/auth/logout', auth, async (req, res) => {
  await pool.query('UPDATE device_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2', [req.user.sid, req.user.sub]);
  res.status(204).end();
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,email,name,role,created_at FROM users WHERE id=$1', [req.user.sub]);
  res.json(rows[0]);
});

app.get('/api/security/2fa', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.totp_enabled,
       COUNT(rc.id) FILTER (WHERE rc.used_at IS NULL)::int AS recovery_codes_remaining
     FROM users u LEFT JOIN two_factor_recovery_codes rc ON rc.user_id=u.id
     WHERE u.id=$1 GROUP BY u.id`,
    [req.user.sub]
  );
  res.set('Cache-Control', 'no-store').json({
    enabled: Boolean(rows[0]?.totp_enabled),
    recoveryCodesRemaining: rows[0]?.recovery_codes_remaining || 0
  });
});

app.post('/api/security/2fa/setup', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,email,name,totp_enabled FROM users WHERE id=$1', [req.user.sub]);
  const account = rows[0];
  if (!account) return res.status(404).json({ error: 'Utente non trovato' });
  if (account.totp_enabled) return res.status(409).json({ error: 'Autenticazione a due fattori già attiva' });
  const secret = new OTPAuth.Secret({ size: 20 }).base32;
  await pool.query('UPDATE users SET totp_secret_encrypted=$1 WHERE id=$2', [encryptTotpSecret(secret), account.id]);
  const uri = totpFor(account, secret).toString();
  const qrCode = await QRCode.toDataURL(uri, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
  res.set('Cache-Control', 'no-store').json({ qrCode, manualKey: secret });
});

app.post('/api/security/2fa/enable', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id,email,totp_enabled,totp_secret_encrypted FROM users WHERE id=$1 FOR UPDATE',
      [req.user.sub]
    );
    const account = rows[0];
    if (!account?.totp_secret_encrypted) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Avvia prima la configurazione' });
    }
    if (account.totp_enabled) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Autenticazione a due fattori già attiva' });
    }
    const code = normalizeSecondFactorCode(req.body.code);
    const valid = /^\d{6}$/.test(code) && totpFor(account, decryptTotpSecret(account.totp_secret_encrypted)).validate({ token: code, window: 1 }) !== null;
    if (!valid) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Codice di verifica non valido' });
    }
    await client.query('UPDATE users SET totp_enabled=true WHERE id=$1', [account.id]);
    const recoveryCodes = await replaceRecoveryCodes(account.id, client);
    await client.query('UPDATE device_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [account.id, req.user.sid]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store').json({ recoveryCodes });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/security/2fa/recovery-codes', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT id,email,totp_enabled,totp_secret_encrypted FROM users WHERE id=$1 FOR UPDATE',
      [req.user.sub]
    );
    const account = rows[0];
    if (!account?.totp_enabled) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Autenticazione a due fattori non attiva' });
    }
    if (!(await verifySecondFactor(account, req.body.code, client))) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Codice di verifica non valido' });
    }
    const recoveryCodes = await replaceRecoveryCodes(account.id, client);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store').json({ recoveryCodes });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.post('/api/security/2fa/disable', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [req.user.sub]);
    const account = rows[0];
    const passwordValid = account && await bcrypt.compare(String(req.body.password || ''), account.password_hash);
    if (!passwordValid || !account.totp_enabled || !(await verifySecondFactor(account, req.body.code, client))) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Password o codice di verifica non validi' });
    }
    await client.query('UPDATE users SET totp_enabled=false,totp_secret_encrypted=NULL WHERE id=$1', [account.id]);
    await client.query('DELETE FROM two_factor_recovery_codes WHERE user_id=$1', [account.id]);
    await client.query('UPDATE device_sessions SET revoked_at=now() WHERE user_id=$1 AND id<>$2 AND revoked_at IS NULL', [account.id, req.user.sid]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

app.get('/api/devices', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,device_name,platform,last_ip,created_at,last_used_at,expires_at,(id=$2) AS current
     FROM device_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
     ORDER BY last_used_at DESC`,
    [req.user.sub, req.user.sid]
  );
  res.json(rows);
});

app.delete('/api/devices/:id', auth, async (req, res) => {
  const result = await pool.query(
    'UPDATE device_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL',
    [req.params.id, req.user.sub]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Dispositivo non trovato' });
  res.status(204).end();
});

app.get('/api/storage', auth, async (_req, res) => {
  const [{ rows }, stats] = await Promise.all([
    pool.query("SELECT COALESCE(SUM(size_bytes), 0)::bigint AS files_bytes, COUNT(*)::int AS file_count FROM entries WHERE kind='file'"),
    fs.statfs(STORAGE_DIR)
  ]);
  const totalBytes = Number(stats.blocks) * Number(stats.bsize);
  const freeBytes = Number(stats.bavail) * Number(stats.bsize);
  const diskUsedBytes = Math.max(0, totalBytes - freeBytes);
  res.json({
    filesBytes: Number(rows[0].files_bytes),
    fileCount: rows[0].file_count,
    totalBytes,
    freeBytes,
    diskUsedBytes,
    diskUsedPercent: totalBytes ? Math.round((diskUsedBytes / totalBytes) * 1000) / 10 : 0
  });
});

app.get('/api/changes', auth, async (req, res) => {
  const cursor = Math.max(0, Number(req.query.cursor || 0));
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 200)));
  const { rows } = await pool.query(
    `SELECT id,entry_id,action,payload,created_at
     FROM changes WHERE user_id=$1 AND id>$2
     ORDER BY id ASC LIMIT $3`,
    [req.user.sub, cursor, limit]
  );
  res.json({
    changes: rows,
    nextCursor: rows.length ? Number(rows[rows.length - 1].id) : cursor,
    hasMore: rows.length === limit
  });
});

app.get('/api/sync/bootstrap', auth, async (req, res) => {
  const [entriesResult, cursorResult] = await Promise.all([
    pool.query(
      `SELECT DISTINCT e.id,e.parent_id,e.name,e.kind,e.mime_type,e.size_bytes,e.is_system,e.is_trashed,e.created_at,e.updated_at,
         u.name AS owner_name,(e.owner_id=$1) AS owned
       FROM entries e
       JOIN users u ON u.id=e.owner_id
       LEFT JOIN shares s ON s.entry_id=e.id AND s.user_id=$1
       WHERE e.owner_id=$1 OR s.user_id=$1 OR EXISTS(SELECT 1 FROM users me WHERE me.id=$1 AND me.role='admin')
       ORDER BY e.id`,
      [req.user.sub]
    ),
    pool.query('SELECT COALESCE(MAX(id),0)::bigint AS cursor FROM changes WHERE user_id=$1', [req.user.sub])
  ]);
  res.json({ entries: entriesResult.rows, cursor: Number(cursorResult.rows[0].cursor) });
});

app.get('/api/users', auth, admin, async (_req, res) => {
  const { rows } = await pool.query('SELECT id,email,name,role,created_at FROM users ORDER BY name');
  res.json(rows);
});

app.post('/api/users', auth, admin, async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const name = cleanName(req.body.name);
    const password = String(req.body.password || '');
    const role = ['admin', 'member', 'viewer'].includes(req.body.role) ? req.body.role : 'member';
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10) throw new Error('Dati utente non validi');
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users(email,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING id,email,name,role,created_at',
      [email, name, hash, role]
    );
    await ensureImagesFolder(rows[0].id);
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.code === '23505' ? 'Email già utilizzata' : error.message });
  }
});

app.get('/api/entries', auth, async (req, res) => {
  const trash = req.query.trash === 'true';
  const search = String(req.query.q || '').trim();
  const parentId = req.query.parentId || null;
  const images = req.query.images === 'true';
  const params = [req.user.sub, trash, parentId, search ? `%${search}%` : null, images];
  const { rows } = await pool.query(
    `SELECT e.id,e.parent_id,e.name,e.kind,e.mime_type,e.size_bytes,e.is_system,e.is_trashed,e.created_at,e.updated_at,
       u.name AS owner_name, (e.owner_id = $1) AS owned
     FROM entries e
     JOIN users u ON u.id=e.owner_id
     LEFT JOIN shares s ON s.entry_id=e.id AND s.user_id=$1
     WHERE (e.owner_id=$1 OR s.user_id=$1 OR EXISTS(SELECT 1 FROM users me WHERE me.id=$1 AND me.role='admin'))
       AND e.is_trashed=$2
       AND ($5::boolean OR $4::text IS NOT NULL OR e.parent_id IS NOT DISTINCT FROM $3::uuid)
       AND ($4::text IS NULL OR e.name ILIKE $4)
       AND (NOT $5::boolean OR (e.kind='file' AND e.mime_type LIKE 'image/%'))
     ORDER BY e.kind DESC, lower(e.name)`,
    params
  );
  res.json(rows);
});

app.get('/api/folders', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT e.id,e.parent_id,e.name
     FROM entries e
     LEFT JOIN shares s ON s.entry_id=e.id AND s.user_id=$1
     WHERE e.kind='folder' AND e.is_trashed=false
       AND (e.owner_id=$1 OR s.user_id=$1 OR EXISTS(SELECT 1 FROM users me WHERE me.id=$1 AND me.role='admin'))
     ORDER BY e.name`,
    [req.user.sub]
  );
  res.json(rows);
});

app.post('/api/folders', auth, writable, async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const parentId = req.body.parentId || null;
    if (parentId) {
      const parent = await canAccess(parentId, req.user.sub, true);
      if (!parent) return res.status(403).json({ error: 'Cartella non accessibile' });
      if (parent.is_system) return res.status(400).json({ error: 'La cartella Immagini può contenere solo immagini' });
    }
    const { rows } = await pool.query(
      'INSERT INTO entries(parent_id,owner_id,name,kind) VALUES($1,$2,$3,\'folder\') RETURNING *',
      [parentId, req.user.sub, name]
    );
    await recordChange(pool, rows[0].id, 'created', { kind: 'folder', parentId });
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/uploads', auth, writable, async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const totalBytes = Number(req.body.size);
    const mimeType = String(req.body.mimeType || 'application/octet-stream').slice(0, 255);
    const parentId = req.body.parentId || null;
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'Dimensione file non valida' });
    }
    if (parentId && !(await canAccess(parentId, req.user.sub, true))) {
      return res.status(403).json({ error: 'Cartella non accessibile' });
    }
    const storageName = `${crypto.randomUUID()}.part`;
    await fs.writeFile(path.join(STORAGE_DIR, storageName), '');
    const { rows } = await pool.query(
      `INSERT INTO upload_sessions(owner_id,parent_id,name,mime_type,total_bytes,storage_name,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+interval '24 hours')
       RETURNING id,received_bytes,total_bytes,expires_at`,
      [req.user.sub, parentId, name, mimeType, totalBytes, storageName]
    );
    res.status(201).json({
      uploadId: rows[0].id,
      offset: Number(rows[0].received_bytes),
      size: Number(rows[0].total_bytes),
      expiresAt: rows[0].expires_at,
      chunkSize: MAX_UPLOAD_CHUNK
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/uploads/:id', auth, writable, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,name,mime_type,received_bytes,total_bytes,expires_at
     FROM upload_sessions WHERE id=$1 AND owner_id=$2 AND expires_at>now()`,
    [req.params.id, req.user.sub]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Upload non trovato o scaduto' });
  res.json({
    uploadId: rows[0].id,
    name: rows[0].name,
    mimeType: rows[0].mime_type,
    offset: Number(rows[0].received_bytes),
    size: Number(rows[0].total_bytes),
    expiresAt: rows[0].expires_at
  });
});

app.patch(
  '/api/uploads/:id',
  auth,
  writable,
  express.raw({ type: 'application/octet-stream', limit: MAX_UPLOAD_CHUNK }),
  async (req, res) => {
    const requestedOffset = Number(req.headers['upload-offset']);
    if (!Number.isSafeInteger(requestedOffset) || !Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: 'Blocco upload non valido' });
    }
    const client = await pool.connect();
    let session;
    let renamedFile;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        'SELECT * FROM upload_sessions WHERE id=$1 AND owner_id=$2 AND expires_at>now() FOR UPDATE',
        [req.params.id, req.user.sub]
      );
      session = result.rows[0];
      if (!session) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Upload non trovato o scaduto' });
      }
      const currentOffset = Number(session.received_bytes);
      const totalBytes = Number(session.total_bytes);
      if (requestedOffset !== currentOffset) {
        await client.query('ROLLBACK');
        res.setHeader('Upload-Offset', currentOffset);
        return res.status(409).json({ error: 'Offset non valido', offset: currentOffset });
      }
      if (currentOffset + req.body.length > totalBytes) {
        await client.query('ROLLBACK');
        return res.status(413).json({ error: 'Il blocco supera la dimensione dichiarata' });
      }
      const partPath = path.join(STORAGE_DIR, session.storage_name);
      const handle = await fs.open(partPath, 'r+');
      try {
        await handle.write(req.body, 0, req.body.length, currentOffset);
      } finally {
        await handle.close();
      }
      const nextOffset = currentOffset + req.body.length;
      if (nextOffset < totalBytes) {
        await client.query('UPDATE upload_sessions SET received_bytes=$1,updated_at=now() WHERE id=$2', [nextOffset, session.id]);
        await client.query('COMMIT');
        res.setHeader('Upload-Offset', nextOffset);
        return res.status(204).end();
      }
      const finalStorageName = session.storage_name.replace(/\.part$/, '');
      const finalPath = path.join(STORAGE_DIR, finalStorageName);
      await fs.rename(partPath, finalPath);
      renamedFile = { partPath, finalPath };
      const entryResult = await client.query(
        `INSERT INTO entries(parent_id,owner_id,name,kind,mime_type,size_bytes,storage_name)
         VALUES($1,$2,$3,'file',$4,$5,$6) RETURNING *`,
        [session.parent_id, req.user.sub, session.name, session.mime_type, totalBytes, finalStorageName]
      );
      await recordChange(client, entryResult.rows[0].id, 'created', {
        kind: 'file',
        parentId: session.parent_id,
        sizeBytes: totalBytes,
        resumable: true
      });
      await client.query('DELETE FROM upload_sessions WHERE id=$1', [session.id]);
      await client.query('COMMIT');
      res.setHeader('Upload-Offset', nextOffset);
      res.setHeader('Upload-Complete', 'true');
      res.setHeader('Entry-Id', entryResult.rows[0].id);
      res.status(204).end();
    } catch (error) {
      await client.query('ROLLBACK');
      if (renamedFile) await fs.rename(renamedFile.finalPath, renamedFile.partPath).catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
);

const upload = multer({
  storage: multer.diskStorage({
    destination: STORAGE_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 20 }
});

app.post('/api/files', auth, writable, upload.array('files', 20), async (req, res) => {
  let parentId = req.body.parentId || null;
  if (req.body.collection === 'images') {
    if ((req.files || []).some(file => !file.mimetype.startsWith('image/'))) {
      await Promise.all((req.files || []).map(file => fs.unlink(file.path).catch(() => {})));
      return res.status(400).json({ error: 'Nella raccolta Immagini puoi caricare solo immagini' });
    }
    parentId = await ensureImagesFolder(req.user.sub);
  }
  if (parentId) {
    const parent = await canAccess(parentId, req.user.sub, true);
    if (!parent) {
      await Promise.all((req.files || []).map(file => fs.unlink(file.path).catch(() => {})));
      return res.status(403).json({ error: 'Cartella non accessibile' });
    }
    if (parent.is_system && (req.files || []).some(file => !file.mimetype.startsWith('image/'))) {
      await Promise.all((req.files || []).map(file => fs.unlink(file.path).catch(() => {})));
      return res.status(400).json({ error: 'Nella cartella Immagini puoi caricare solo immagini' });
    }
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = [];
    for (const file of req.files || []) {
      const { rows } = await client.query(
        `INSERT INTO entries(parent_id,owner_id,name,kind,mime_type,size_bytes,storage_name)
         VALUES($1,$2,$3,'file',$4,$5,$6) RETURNING *`,
        [parentId, req.user.sub, cleanName(Buffer.from(file.originalname, 'latin1').toString('utf8')), file.mimetype, file.size, file.filename]
      );
      await recordChange(client, rows[0].id, 'created', { kind: 'file', parentId, sizeBytes: file.size });
      created.push(rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK');
    await Promise.all((req.files || []).map(file => fs.unlink(file.path).catch(() => {})));
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.get('/api/nas', auth, async (req, res) => {
  try {
    const location = await existingNasPath(req.query.path || '');
    const query = String(req.query.q || '').trim().toLocaleLowerCase('it');
    const children = await fs.readdir(location.real, { withFileTypes: true });
    const entries = await Promise.all(children
      .filter(item => !item.isSymbolicLink() && (!query || item.name.toLocaleLowerCase('it').includes(query)))
      .map(async item => {
        const relative = location.relative ? `${location.relative}/${item.name}` : item.name;
        const stat = await fs.stat(path.join(location.real, item.name));
        return {
          id: relative,
          parent_id: location.relative || null,
          name: item.name,
          kind: item.isDirectory() ? 'folder' : 'file',
          mime_type: item.isDirectory() ? null : nasMime(item.name),
          size_bytes: item.isDirectory() ? 0 : stat.size,
          updated_at: stat.mtime,
          owner_name: 'NAS',
          is_system: false,
          nas: true
        };
      }));
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }) : a.kind === 'folder' ? -1 : 1);
    res.json(entries);
  } catch (error) {
    res.status(error.status || (error.code === 'ENOENT' ? 404 : 400)).json({ error: error.code === 'ENOENT' ? 'Cartella NAS non trovata' : error.message });
  }
});

app.get('/api/nas/content', auth, async (req, res) => {
  try {
    const item = await existingNasPath(req.query.path || '');
    const stat = await fs.stat(item.real);
    if (!stat.isFile()) return res.status(400).json({ error: 'Il percorso NAS non è un file' });
    res.setHeader('Content-Type', nasMime(path.basename(item.real)));
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(item.real))}`);
    res.sendFile(item.real);
  } catch (error) {
    res.status(error.status || (error.code === 'ENOENT' ? 404 : 400)).json({ error: error.code === 'ENOENT' ? 'File NAS non trovato' : error.message });
  }
});

app.get('/api/nas/thumbnail', auth, async (req, res) => {
  try {
    const item = await existingNasPath(req.query.path || '');
    const stat = await fs.stat(item.real);
    if (!stat.isFile() || !nasMime(item.real).startsWith('image/')) return res.status(404).json({ error: 'Immagine NAS non trovata' });
    await sendThumbnail(item.real, `nas:${item.real}:${stat.size}:${stat.mtimeMs}`, res);
  } catch (error) {
    res.status(error.status || (error.code === 'ENOENT' ? 404 : 400)).json({ error: error.code === 'ENOENT' ? 'Immagine NAS non trovata' : error.message });
  }
});

app.post('/api/nas/folders', auth, writable, async (req, res) => {
  try {
    const destination = await newNasPath(req.body.path || '', req.body.name);
    await fs.mkdir(destination.target);
    res.status(201).json({ id: destination.childRelative, name: destination.name, kind: 'folder', nas: true });
  } catch (error) {
    res.status(error.code === 'EEXIST' ? 409 : error.status || 400).json({ error: error.code === 'EEXIST' ? 'Esiste già un elemento con questo nome' : error.message });
  }
});

app.post('/api/nas/files', auth, writable, upload.array('files', 20), async (req, res) => {
  const temporaryFiles = req.files || [];
  const createdPaths = [];
  try {
    const parent = await existingNasPath(req.body.path || '');
    const created = [];
    for (const file of temporaryFiles) {
      const name = cleanName(Buffer.from(file.originalname, 'latin1').toString('utf8'));
      const target = path.join(parent.real, name);
      if (!isInside(parent.root, target)) throw new Error('Percorso NAS non valido');
      await fs.copyFile(file.path, target, fs.constants.COPYFILE_EXCL);
      createdPaths.push(target);
      await fs.unlink(file.path);
      created.push({ id: parent.relative ? `${parent.relative}/${name}` : name, name, kind: 'file', nas: true });
    }
    res.status(201).json(created);
  } catch (error) {
    await Promise.all(temporaryFiles.map(file => fs.unlink(file.path).catch(() => {})));
    await Promise.all(createdPaths.map(target => fs.unlink(target).catch(() => {})));
    res.status(error.code === 'EEXIST' ? 409 : error.status || 400).json({ error: error.code === 'EEXIST' ? 'Esiste già un file con questo nome' : error.message });
  }
});

app.patch('/api/nas/rename', auth, writable, async (req, res) => {
  try {
    const source = await existingNasPath(req.body.path || '');
    if (!source.relative) return res.status(400).json({ error: 'La cartella principale del NAS non può essere rinominata' });
    const destination = await newNasPath(path.posix.dirname(source.relative) === '.' ? '' : path.posix.dirname(source.relative), req.body.name);
    await fs.access(destination.target).then(() => { const conflict = new Error('Esiste già un elemento con questo nome'); conflict.code = 'EEXIST'; throw conflict; }).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rename(source.real, destination.target);
    res.json({ id: destination.childRelative, name: destination.name });
  } catch (error) {
    res.status(error.code === 'EEXIST' ? 409 : error.status || 400).json({ error: error.code === 'EEXIST' ? 'Esiste già un elemento con questo nome' : error.message });
  }
});

app.delete('/api/nas', auth, writable, async (req, res) => {
  try {
    const item = await existingNasPath(req.query.path || '');
    if (!item.relative) return res.status(400).json({ error: 'La cartella principale del NAS non può essere eliminata' });
    await fs.rm(item.real, { recursive: true, force: false });
    res.status(204).end();
  } catch (error) {
    res.status(error.status || (error.code === 'ENOENT' ? 404 : 400)).json({ error: error.code === 'ENOENT' ? 'Elemento NAS non trovato' : error.message });
  }
});

app.get('/api/entries/:id/editor', auth, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, false);
  const extension = officeExtension(entry?.name);
  if (!entry || entry.kind !== 'file' || entry.is_trashed || !OFFICE_EXTENSIONS.has(extension)) {
    return res.status(404).json({ error: 'Documento modificabile non trovato' });
  }
  const editableEntry = req.user.role !== 'viewer' ? await canAccess(entry.id, req.user.sub, true) : null;
  const canWrite = Boolean(editableEntry);
  const { rows: userRows } = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.sub]);
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
  const accessToken = jwt.sign(
    { typ: 'wopi', sub: req.user.sub, entryId: entry.id, canWrite, name: userRows[0]?.name },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  const wopiSource = `${WOPI_INTERNAL_URL}/api/wopi/files/${entry.id}`;
  const configuredPublicUrl = String(process.env.COLLABORA_PUBLIC_URL || '').replace(/\/$/, '');
  const publicUrl = configuredPublicUrl || `http://${req.hostname}:9980`;
  try {
    const actionUrl = await collaboraActionUrl(extension, publicUrl, wopiSource);
    res.json({ actionUrl, accessToken, accessTokenTtl: expiresAt, canWrite });
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

app.get('/api/wopi/files/:id', wopiToken, async (req, res) => {
  const entry = await canAccess(req.params.id, req.wopi.sub, false);
  if (!entry || entry.kind !== 'file' || entry.is_trashed) return res.status(404).json({ error: 'File non trovato' });
  const canWrite = Boolean(req.wopi.canWrite && await canAccess(entry.id, req.wopi.sub, true));
  res.json({
    BaseFileName: entry.name,
    Size: Number(entry.size_bytes),
    Version: new Date(entry.updated_at).getTime().toString(),
    OwnerId: entry.owner_id,
    UserId: req.wopi.sub,
    UserFriendlyName: req.wopi.name || 'Utente Arca Drive',
    UserCanWrite: canWrite,
    ReadOnly: !canWrite,
    SupportsLocks: true,
    SupportsGetLock: true,
    SupportsUpdate: true,
    SupportsRename: false,
    UserCanNotWriteRelative: true,
    FileNameMaxLength: 255,
    LastModifiedTime: new Date(entry.updated_at).toISOString()
  });
});

app.get('/api/wopi/files/:id/contents', wopiToken, async (req, res) => {
  const entry = await canAccess(req.params.id, req.wopi.sub, false);
  if (!entry || entry.kind !== 'file' || entry.is_trashed) return res.status(404).end();
  res.type(entry.mime_type || 'application/octet-stream');
  res.sendFile(path.join(STORAGE_DIR, entry.storage_name));
});

app.post(
  '/api/wopi/files/:id/contents',
  wopiToken,
  express.raw({ type: '*/*', limit: MAX_FILE_SIZE }),
  async (req, res) => {
    const entry = await canAccess(req.params.id, req.wopi.sub, true);
    if (!req.wopi.canWrite || !entry || entry.kind !== 'file' || entry.is_trashed) return res.status(403).end();
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'Contenuto documento non valido' });

    await pool.query('DELETE FROM wopi_locks WHERE expires_at<=now()');
    const activeLock = await pool.query('SELECT lock_id FROM wopi_locks WHERE entry_id=$1', [entry.id]);
    const requestedLock = String(req.headers['x-wopi-lock'] || '');
    if (activeLock.rows[0] && activeLock.rows[0].lock_id !== requestedLock) {
      res.setHeader('X-WOPI-Lock', activeLock.rows[0].lock_id);
      return res.status(409).end();
    }

    const temporaryPath = path.join(STORAGE_DIR, `${entry.storage_name}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, req.body, { flag: 'wx' });
      await fs.rename(temporaryPath, path.join(STORAGE_DIR, entry.storage_name));
      const { rows } = await pool.query(
        'UPDATE entries SET size_bytes=$1,updated_at=now() WHERE id=$2 RETURNING updated_at',
        [req.body.length, entry.id]
      );
      await recordChange(pool, entry.id, 'updated', { sizeBytes: req.body.length, source: 'collabora' });
      res.setHeader('X-WOPI-ItemVersion', new Date(rows[0].updated_at).getTime().toString());
      res.json({ LastModifiedTime: new Date(rows[0].updated_at).toISOString() });
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
);

app.post('/api/wopi/files/:id', wopiToken, async (req, res) => {
  const entry = await canAccess(req.params.id, req.wopi.sub, true);
  if (!req.wopi.canWrite || !entry || entry.kind !== 'file' || entry.is_trashed) return res.status(403).end();
  const operation = String(req.headers['x-wopi-override'] || '').toUpperCase();
  const requestedLock = String(req.headers['x-wopi-lock'] || '');
  if (requestedLock.length > 1024) return res.status(400).end();
  await pool.query('DELETE FROM wopi_locks WHERE expires_at<=now()');
  const { rows } = await pool.query('SELECT lock_id FROM wopi_locks WHERE entry_id=$1', [entry.id]);
  const currentLock = rows[0]?.lock_id || '';

  if (operation === 'GET_LOCK') {
    res.setHeader('X-WOPI-Lock', currentLock);
    return res.status(200).end();
  }
  if (operation === 'LOCK') {
    if (currentLock && currentLock !== requestedLock) {
      res.setHeader('X-WOPI-Lock', currentLock);
      return res.status(409).end();
    }
    await pool.query(
      `INSERT INTO wopi_locks(entry_id,lock_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')
       ON CONFLICT(entry_id) DO UPDATE SET lock_id=EXCLUDED.lock_id,expires_at=EXCLUDED.expires_at,updated_at=now()`,
      [entry.id, requestedLock]
    );
    return res.status(200).end();
  }
  if (operation === 'REFRESH_LOCK') {
    if (!currentLock || currentLock !== requestedLock) {
      res.setHeader('X-WOPI-Lock', currentLock);
      return res.status(409).end();
    }
    await pool.query("UPDATE wopi_locks SET expires_at=now()+interval '30 minutes',updated_at=now() WHERE entry_id=$1", [entry.id]);
    return res.status(200).end();
  }
  if (operation === 'UNLOCK') {
    if (!currentLock || currentLock !== requestedLock) {
      res.setHeader('X-WOPI-Lock', currentLock);
      return res.status(409).end();
    }
    await pool.query('DELETE FROM wopi_locks WHERE entry_id=$1', [entry.id]);
    return res.status(200).end();
  }
  res.status(501).end();
});

app.get('/api/entries/:id/thumbnail', auth, async (req, res) => {
  try {
    const entry = await canAccess(req.params.id, req.user.sub, false);
    if (!entry || entry.kind !== 'file' || entry.is_trashed || !entry.mime_type?.startsWith('image/')) return res.status(404).json({ error: 'Immagine non trovata' });
    const source = path.join(STORAGE_DIR, entry.storage_name);
    const stat = await fs.stat(source);
    await sendThumbnail(source, `entry:${entry.id}:${stat.size}:${stat.mtimeMs}`, res);
  } catch (error) {
    res.status(error.code === 'ENOENT' ? 404 : 400).json({ error: error.code === 'ENOENT' ? 'Immagine non trovata' : error.message });
  }
});

app.get('/api/entries/:id/content', auth, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, false);
  if (!entry || entry.kind !== 'file' || entry.is_trashed) return res.status(404).json({ error: 'File non trovato' });
  const filePath = path.join(STORAGE_DIR, entry.storage_name);
  res.type(entry.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
  res.sendFile(filePath);
});

app.patch('/api/entries/:id/rename', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry || entry.is_trashed) return res.status(404).json({ error: 'Elemento non trovato' });
  if (entry.is_system) return res.status(400).json({ error: 'La cartella Immagini è fissa e non può essere rinominata' });
  try {
    const name = cleanName(req.body.name);
    const { rows } = await pool.query('UPDATE entries SET name=$1,updated_at=now() WHERE id=$2 RETURNING id,name,updated_at', [name, entry.id]);
    await recordChange(pool, entry.id, 'updated', { name });
    res.json(rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/entries/:id/copy', auth, writable, async (req, res) => {
  const source = await canAccess(req.params.id, req.user.sub, false);
  if (!source || source.is_trashed) return res.status(404).json({ error: 'Elemento non trovato' });
  const parentId = req.body.parentId || null;
  let destination = null;
  if (parentId) {
    destination = await canAccess(parentId, req.user.sub, true);
    if (!destination || destination.kind !== 'folder' || destination.is_trashed) return res.status(400).json({ error: 'Cartella di destinazione non valida' });
    if (destination.is_system && (source.kind !== 'file' || !source.mime_type?.startsWith('image/'))) {
      return res.status(400).json({ error: 'Nella cartella Immagini puoi copiare solo immagini' });
    }
    if (source.kind === 'folder') {
      const { rows } = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM entries WHERE id=$1
           UNION ALL SELECT e.id FROM entries e JOIN descendants d ON e.parent_id=d.id
         ) SELECT EXISTS(SELECT 1 FROM descendants WHERE id=$2) AS invalid`,
        [source.id, parentId]
      );
      if (rows[0].invalid) return res.status(400).json({ error: 'Non puoi copiare una cartella dentro sé stessa' });
    }
  }

  const duplicateName = value => {
    const dot = value.lastIndexOf('.');
    return dot > 0 ? `${value.slice(0, dot)} - copia${value.slice(dot)}` : `${value} - copia`;
  };
  const client = await pool.connect();
  const copiedFiles = [];
  try {
    await client.query('BEGIN');
    const clone = async (sourceId, newParentId, root = false) => {
      const { rows } = await client.query('SELECT * FROM entries WHERE id=$1 AND is_trashed=false', [sourceId]);
      const item = rows[0];
      if (!item) throw new Error('Elemento sorgente non trovato');
      let storageName = null;
      if (item.kind === 'file') {
        storageName = crypto.randomUUID();
        await fs.copyFile(path.join(STORAGE_DIR, item.storage_name), path.join(STORAGE_DIR, storageName));
        copiedFiles.push(storageName);
      }
      const name = root ? cleanName(req.body.name || duplicateName(item.name)) : item.name;
      const inserted = await client.query(
        `INSERT INTO entries(parent_id,owner_id,name,kind,mime_type,size_bytes,storage_name,is_system)
         VALUES($1,$2,$3,$4,$5,$6,$7,false) RETURNING *`,
        [newParentId, req.user.sub, name, item.kind, item.mime_type, item.size_bytes, storageName]
      );
      const copy = inserted.rows[0];
      if (item.kind === 'folder') {
        const children = await client.query('SELECT id FROM entries WHERE parent_id=$1 AND is_trashed=false ORDER BY created_at', [item.id]);
        for (const child of children.rows) await clone(child.id, copy.id, false);
      }
      return copy;
    };
    const created = await clone(source.id, parentId, true);
    await recordChange(client, created.id, 'created', { kind: created.kind, parentId, copiedFrom: source.id });
    await client.query('COMMIT');
    res.status(201).json(created);
  } catch (error) {
    await client.query('ROLLBACK');
    await Promise.all(copiedFiles.map(name => fs.unlink(path.join(STORAGE_DIR, name)).catch(() => {})));
    res.status(400).json({ error: error.message });
  } finally {
    client.release();
  }
});

app.patch('/api/entries/:id/move', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry || entry.is_trashed) return res.status(404).json({ error: 'Elemento non trovato' });
  if (entry.is_system) return res.status(400).json({ error: 'La cartella Immagini è fissa e non può essere spostata' });
  const parentId = req.body.parentId || null;
  if (parentId === entry.id) return res.status(400).json({ error: 'Una cartella non può contenere sé stessa' });
  if (parentId) {
    const destination = await canAccess(parentId, req.user.sub, true);
    if (!destination || destination.kind !== 'folder' || destination.is_trashed) {
      return res.status(400).json({ error: 'Cartella di destinazione non valida' });
    }
    if (destination.is_system && (entry.kind !== 'file' || !entry.mime_type?.startsWith('image/'))) {
      return res.status(400).json({ error: 'Nella cartella Immagini puoi spostare solo immagini' });
    }
    if (entry.kind === 'folder') {
      const { rows } = await pool.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM entries WHERE parent_id = $1
           UNION ALL
           SELECT e.id FROM entries e JOIN descendants d ON e.parent_id = d.id
         )
         SELECT EXISTS(SELECT 1 FROM descendants WHERE id = $2) AS invalid`,
        [entry.id, parentId]
      );
      if (rows[0].invalid) return res.status(400).json({ error: 'Non puoi spostare una cartella in una sua sottocartella' });
    }
  }
  const { rows } = await pool.query(
    'UPDATE entries SET parent_id=$1,updated_at=now() WHERE id=$2 RETURNING id,parent_id,name,kind,updated_at',
    [parentId, entry.id]
  );
  await recordChange(pool, entry.id, 'moved', { parentId });
  res.json(rows[0]);
});

app.delete('/api/entries/:id', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry) return res.status(404).json({ error: 'Elemento non trovato' });
  if (entry.is_system) return res.status(400).json({ error: 'La cartella Immagini è fissa e non può essere eliminata' });
  await pool.query('UPDATE entries SET is_trashed=true,trashed_at=now(),updated_at=now() WHERE id=$1', [req.params.id]);
  await recordChange(pool, entry.id, 'trashed');
  res.status(204).end();
});

app.post('/api/entries/:id/restore', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry || !entry.is_trashed) return res.status(404).json({ error: 'Elemento non trovato nel cestino' });
  const { rows } = await pool.query(
    `UPDATE entries e SET
       is_trashed=false,
       trashed_at=NULL,
       parent_id=CASE
         WHEN e.parent_id IS NULL OR EXISTS(SELECT 1 FROM entries p WHERE p.id=e.parent_id AND p.is_trashed=false) THEN e.parent_id
         ELSE NULL
       END,
       updated_at=now()
     WHERE e.id=$1 RETURNING parent_id`,
    [req.params.id]
  );
  await recordChange(pool, entry.id, 'restored', { parentId: rows[0].parent_id });
  res.status(204).end();
});

app.delete('/api/entries/:id/permanent', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry || !entry.is_trashed) return res.status(404).json({ error: 'Elemento non trovato nel cestino' });

  const client = await pool.connect();
  let storageNames = [];
  try {
    await client.query('BEGIN');
    const descendants = await client.query(
      `WITH RECURSIVE tree AS (
         SELECT id,storage_name FROM entries WHERE id=$1
         UNION ALL
         SELECT child.id,child.storage_name FROM entries child JOIN tree parent ON child.parent_id=parent.id
       )
       SELECT storage_name FROM tree WHERE storage_name IS NOT NULL`,
      [entry.id]
    );
    storageNames = descendants.rows.map(row => row.storage_name);
    await recordChange(client, entry.id, 'deleted', { permanent: true });
    await client.query('DELETE FROM entries WHERE id=$1', [entry.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  await Promise.all(storageNames.map(storageName => fs.unlink(path.join(STORAGE_DIR, storageName)).catch(error => {
    if (error.code !== 'ENOENT') console.error('Impossibile eliminare il file fisico', storageName, error);
  })));
  res.status(204).end();
});

app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules/pdfjs-dist/legacy/build')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File troppo grande' : error.message });
  console.error(error);
  res.status(500).json({ error: 'Errore interno' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Arca Drive listening on :${PORT}`));
async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
