// db.js
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: +(process.env.PGPORT || 5432),
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: +(process.env.PG_CONN_TIMEOUT || 10000),
  idleTimeoutMillis: +(process.env.PG_IDLE_TIMEOUT || 30000),
  max: +(process.env.PGPOOL_MAX || 10),
});

pool.on('error', (err) => {
  console.error('❌ PG pool error:', err);
});

async function ensureDb() {
  try {
    const { rows } = await pool.query('select now() as now');
    console.log('🟢 PostgreSQL reachable. Server time:', rows[0].now);
  } catch (e) {
    console.error('🔴 Cannot reach PostgreSQL:', e.message);
    console.error('👉 Check PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE in .env');
    process.exit(1);
  }
}

module.exports = { pool, ensureDb };
