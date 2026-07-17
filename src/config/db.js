const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set. The server will fail on first query.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : undefined,
  max: 10
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

module.exports = pool;
