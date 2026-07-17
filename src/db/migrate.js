require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[migrate] DATABASE_URL is not set. Attach a Postgres plugin on Railway.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : undefined
  });

  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  console.log('[migrate] Applying schema...');
  await pool.query(sql);
  console.log('[migrate] Schema is up to date.');
  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
