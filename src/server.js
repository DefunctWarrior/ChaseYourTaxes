require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: true, // reflect request origin (fine for now)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.options('*', (req, res) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.sendStatus(204);
});
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    secure: true,
    sameSite: 'none',
    httpOnly: true
  }
}));

// Database pool (uses DATABASE_URL from Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

function toTitleCase(str) {
  if (!str) return str;
  return str.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const userId = parseInt(Buffer.from(authHeader.slice(7), 'base64').toString(), 10);
      if (userId) {
        req.session.userId = userId;
        return next();
      }
    } catch (e) {}
  }
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const result = await query('SELECT role FROM users WHERE id = $1 AND active = TRUE', [req.session.userId]);
    if (!result.rows.length || !['admin', 'superadmin'].includes(result.rows[0].role)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.session.role = result.rows[0].role;
    next();
  } catch (err) {
    res.status(500).json({ error: 'Auth check failed' });
  }
}

function requireSuperAdmin(req, res, next) {
  if (req.session.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super admin required' });
  }
  next();
}

// --- Routes ---

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Chase Your Taxes API' });
});

// Register
app.post('/api/register', async (req, res) => {
  const { first_name, last_name, username, email, password, city, state, county, zip } = req.body;
  if (!first_name || !last_name || !username || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (first_name, last_name, username, email, password_hash, city, state, county, zip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, first_name`,
      [first_name, last_name, username, email, hash, city || null, state || null, county || null, zip || null]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.firstName = user.first_name;
    res.json({ success: true, userId: user.id, firstName: user.first_name });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

  try {
    const result = await query('SELECT * FROM users WHERE username = $1 OR email = $1', [username]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid credentials' });

    const user = result.rows[0];
    if (user.active === false) return res.status(401).json({ error: 'Account is inactive' });

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const token = Buffer.from(String(user.id)).toString('base64');
    res.json({ success: true, firstName: user.first_name, userId: user.id, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/logout', (req, res) => {
  if (req.session) req.session.destroy(() => {});
  res.json({ success: true });
});

// Summary
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const userResult = await query(
      'SELECT city, county, state FROM users WHERE id = $1',
      [req.session.userId]
    );
    const userLoc = userResult.rows[0] || {};

    const rows = await query(`
      SELECT 
        COALESCE(SUM(ti.amount), 0) AS total,
        COALESCE(SUM(CASE WHEN tt.level = 'federal' THEN ti.amount ELSE 0 END), 0) AS federal,
        COALESCE(SUM(CASE WHEN tt.level = 'fica' THEN ti.amount ELSE 0 END), 0) AS fica,
        COALESCE(SUM(CASE WHEN tt.level = 'state' THEN ti.amount ELSE 0 END), 0) AS state,
        COALESCE(SUM(CASE WHEN j.city = $1 AND tt.level = 'local' THEN ti.amount ELSE 0 END), 0) AS city,
        COALESCE(SUM(CASE WHEN j.county = $2 AND tt.level = 'local' THEN ti.amount ELSE 0 END), 0) AS county,
        COALESCE(SUM(CASE WHEN tt.level = 'local' AND (j.city IS NULL OR j.city != $1) AND (j.county IS NULL OR j.county != $2) THEN ti.amount ELSE 0 END), 0) AS other_local
      FROM tax_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN tax_types tt ON ti.tax_type_id = tt.id
      LEFT JOIN jurisdictions j ON ti.jurisdiction_id = j.id
      WHERE t.user_id = $3 AND EXTRACT(YEAR FROM t.date) = EXTRACT(YEAR FROM CURRENT_DATE)
    `, [userLoc.city, userLoc.county, req.session.userId]);

    const recent = await query(`
      SELECT t.date, t.description, tt.name AS category, ti.amount
      FROM tax_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN tax_types tt ON ti.tax_type_id = tt.id
      WHERE t.user_id = $1
      ORDER BY t.date DESC, ti.id DESC
      LIMIT 10
    `, [req.session.userId]);

    res.json({ ...rows.rows[0], recent: recent.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, first_name, last_name, username, email, city, state, county, zip, role, active FROM users WHERE id = $1',
      [req.session.userId]
    );
    res.json(result.rows[0] || {});
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Jurisdictions search
app.get('/api/jurisdictions/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  try {
    const result = await query(
      `SELECT id, display_name, city, county, state, zip
       FROM jurisdictions
       WHERE display_name ILIKE $1 OR city ILIKE $1 OR county ILIKE $1
       ORDER BY display_name
       LIMIT 10`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// Add jurisdiction
app.post('/api/jurisdictions', async (req, res) => {
  let { city, county, state, zip } = req.body;
  city = toTitleCase(city);
  county = toTitleCase(county);
  state = state ? state.trim().toUpperCase() : null;
  zip = zip ? zip.trim() : null;

  const parts = [city, county, state].filter(Boolean);
  const display_name = parts.join(', ') || 'Unknown';

  try {
    const result = await query(
      `INSERT INTO jurisdictions (city, county, state, zip, display_name)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (city, county, state, zip) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING *`,
      [city, county, state, zip, display_name]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add jurisdiction' });
  }
});

app.get('/api/tax-types', async (req, res) => {
  try {
    const result = await query('SELECT id, name, level FROM tax_types ORDER BY name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tax types' });
  }
});

// Log transaction
app.post('/api/transactions', requireAuth, async (req, res) => {
  const { date, description, source_type, notes, tax_items } = req.body;
  if (!date || !tax_items || !Array.isArray(tax_items)) {
    return res.status(400).json({ error: 'Date and tax_items required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txResult = await client.query(
      `INSERT INTO transactions (user_id, date, description, source_type, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.session.userId, date, description || null, source_type || null, notes || null]
    );
    const transactionId = txResult.rows[0].id;

    for (const item of tax_items) {
      await client.query(
        `INSERT INTO tax_items (transaction_id, tax_type_id, jurisdiction_id, amount, notes)
         VALUES ($1, $2, $3, $4, $5)`,
        [transactionId, item.tax_type_id || null, item.jurisdiction_id || null, item.amount, item.notes || null]
      );
    }
    await client.query('COMMIT');
    res.json({ success: true, transactionId });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Failed to save transaction' });
  } finally {
    client.release();
  }
});

// Admin routes
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query(
      'SELECT id, first_name, last_name, username, email, city, state, county, role, active, created_at FROM users ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to list users' });
  }
});

app.get('/api/admin/users/:id/transactions', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await query(`
      SELECT t.id, t.date, t.description, t.source_type, ti.amount, tt.name AS tax_type
      FROM transactions t
      LEFT JOIN tax_items ti ON ti.transaction_id = t.id
      LEFT JOIN tax_types tt ON ti.tax_type_id = tt.id
      WHERE t.user_id = $1
      ORDER BY t.date DESC
    `, [req.params.id]);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

app.post('/api/admin/users/:id/deactivate', requireAuth, requireAdmin, async (req, res) => {
  try {
    await query('UPDATE users SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deactivate' });
  }
});

app.post('/api/admin/users/:id/reactivate', requireAuth, requireAdmin, async (req, res) => {
  try {
    await query('UPDATE users SET active = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reactivate' });
  }
});

app.post('/api/admin/users/:id/role', requireAuth, requireAdmin, requireSuperAdmin, async (req, res) => {
  const { role } = req.body;
  if (!['user', 'admin', 'superadmin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    await query('UPDATE users SET role = $1 WHERE id = $2', [role, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// Static files last
app.use(express.static(path.join(__dirname, '../public')));

app.listen(PORT, () => {
  console.log(`Chase Your Taxes API running on port ${PORT}`);
});
