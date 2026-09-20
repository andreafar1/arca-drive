import express from 'express';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = process.env.STORAGE_DIR || '/data/files';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE_MB || 200) * 1024 * 1024;
const MAX_UPLOAD_CHUNK = Number(process.env.MAX_UPLOAD_CHUNK_MB || 10) * 1024 * 1024;
const ACCESS_TOKEN_MINUTES = Number(process.env.ACCESS_TOKEN_MINUTES || 15);
const REFRESH_TOKEN_DAYS = Number(process.env.REFRESH_TOKEN_DAYS || 30);
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const COLLABORA_INTERNAL_URL = String(process.env.COLLABORA_INTERNAL_URL || 'http://collabora:9980').replace(/\/$/, '');
const WOPI_INTERNAL_URL = String(process.env.WOPI_INTERNAL_URL || 'http://app:3000').replace(/\/$/, '');
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp']);

if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
if (!DATABASE_URL && !process.env.PGHOST) throw new Error('Database configuration is required');

await fs.mkdir(STORAGE_DIR, { recursive: true });
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
  res.json(await createSession(safe, req, req.body));
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

app.get('/api/entries/:id/content', auth, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, false);
  if (!entry || entry.kind !== 'file' || entry.is_trashed) return res.status(404).json({ error: 'File non trovato' });
  const filePath = path.join(STORAGE_DIR, entry.storage_name);
  res.type(entry.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
  res.sendFile(filePath);
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
