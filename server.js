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
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

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

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

function tokenFor(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '12h' });
}

function auth(req, res, next) {
  const value = req.headers.authorization || '';
  try {
    req.user = jwt.verify(value.replace(/^Bearer\s+/i, ''), JWT_SECRET);
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
    res.status(201).json({ token: tokenFor(rows[0]), user: rows[0] });
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
  res.json({ token: tokenFor(safe), user: safe });
});

app.get('/api/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,email,name,role,created_at FROM users WHERE id=$1', [req.user.sub]);
  res.json(rows[0]);
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
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.code === '23505' ? 'Email già utilizzata' : error.message });
  }
});

app.get('/api/entries', auth, async (req, res) => {
  const trash = req.query.trash === 'true';
  const search = String(req.query.q || '').trim();
  const parentId = req.query.parentId || null;
  const params = [req.user.sub, trash, parentId, search ? `%${search}%` : null];
  const { rows } = await pool.query(
    `SELECT e.id,e.parent_id,e.name,e.kind,e.mime_type,e.size_bytes,e.is_trashed,e.created_at,e.updated_at,
       u.name AS owner_name, (e.owner_id = $1) AS owned
     FROM entries e
     JOIN users u ON u.id=e.owner_id
     LEFT JOIN shares s ON s.entry_id=e.id AND s.user_id=$1
     WHERE (e.owner_id=$1 OR s.user_id=$1 OR EXISTS(SELECT 1 FROM users me WHERE me.id=$1 AND me.role='admin'))
       AND e.is_trashed=$2
       AND ($4::text IS NOT NULL OR e.parent_id IS NOT DISTINCT FROM $3::uuid)
       AND ($4::text IS NULL OR e.name ILIKE $4)
     ORDER BY e.kind DESC, lower(e.name)`,
    params
  );
  res.json(rows);
});

app.post('/api/folders', auth, writable, async (req, res) => {
  try {
    const name = cleanName(req.body.name);
    const parentId = req.body.parentId || null;
    if (parentId && !(await canAccess(parentId, req.user.sub, true))) return res.status(403).json({ error: 'Cartella non accessibile' });
    const { rows } = await pool.query(
      'INSERT INTO entries(parent_id,owner_id,name,kind) VALUES($1,$2,$3,\'folder\') RETURNING *',
      [parentId, req.user.sub, name]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: STORAGE_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID())
  }),
  limits: { fileSize: MAX_FILE_SIZE, files: 20 }
});

app.post('/api/files', auth, writable, upload.array('files', 20), async (req, res) => {
  const parentId = req.body.parentId || null;
  if (parentId && !(await canAccess(parentId, req.user.sub, true))) {
    await Promise.all((req.files || []).map(file => fs.unlink(file.path).catch(() => {})));
    return res.status(403).json({ error: 'Cartella non accessibile' });
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

app.get('/api/entries/:id/content', auth, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, false);
  if (!entry || entry.kind !== 'file' || entry.is_trashed) return res.status(404).json({ error: 'File non trovato' });
  const filePath = path.join(STORAGE_DIR, entry.storage_name);
  res.type(entry.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(entry.name)}`);
  res.sendFile(filePath);
});

app.delete('/api/entries/:id', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry) return res.status(404).json({ error: 'Elemento non trovato' });
  await pool.query('UPDATE entries SET is_trashed=true,trashed_at=now(),updated_at=now() WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

app.post('/api/entries/:id/restore', auth, writable, async (req, res) => {
  const entry = await canAccess(req.params.id, req.user.sub, true);
  if (!entry) return res.status(404).json({ error: 'Elemento non trovato' });
  await pool.query('UPDATE entries SET is_trashed=false,trashed_at=NULL,parent_id=NULL,updated_at=now() WHERE id=$1', [req.params.id]);
  res.status(204).end();
});

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
