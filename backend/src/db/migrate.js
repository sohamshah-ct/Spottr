require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function migrate() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error('ERROR: DATABASE_URL not set'); process.exit(1); }
  const isInternal = dbUrl.includes('.railway.internal');
  const client = new Client({ connectionString: dbUrl, ssl: isInternal ? false : { rejectUnauthorized: false } });
  console.log('Connecting to database...');
  await client.connect();
  console.log('Connected.');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('Running schema migrations...');
  await client.query(sql);
  console.log('Schema applied successfully.');
  const result = await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  console.log('Tables:', result.rows.map(r => r.tablename));
  await client.end();
  console.log('Migration complete.');
}

migrate().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
