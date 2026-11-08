import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const checks = [];
const record = (name, passed) => checks.push({ name, passed: Boolean(passed) });
let client, readiness;
try {
  const { env, durationInMilliseconds } = await import('../src/config/env.js');
  readiness = await import('../src/lib/readiness.js');
  record('Production environment and HTTPS enforcement', env.nodeEnv === 'production' && env.enforceHttps);
  record('Explicit private persistent upload root configured', Boolean(process.env.UPLOAD_ROOT));
  record('Short staff sessions (5 to 60 minutes)', durationInMilliseconds(env.jwtAccessExpiresIn) >= 300000 && durationInMilliseconds(env.jwtAccessExpiresIn) <= 3600000);
  const db = new URL(env.databaseUrl);
  record('Remote PostgreSQL uses verified TLS', ['localhost', '127.0.0.1', '[::1]'].includes(db.hostname) || db.searchParams.get('sslmode') === 'verify-full');
  try { await readiness.checkReadiness(); record('Database responds and evidence storage is writable', true); }
  catch { record('Database responds and evidence storage is writable', false); }
  client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 3000, query_timeout: 3000 });
  await client.connect();
  const role = (await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname = current_user')).rows[0];
  const ddl = (await client.query("SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS create_schema, EXISTS(SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS owns_tables")).rows[0];
  record('Runtime database role has no administration or schema ownership', role && !Object.values(role).some(Boolean) && !ddl.create_schema && !ddl.owns_tables);
  const migrations = (await readdir(fileURLToPath(new URL('../prisma/migrations/', import.meta.url)), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  const applied = (await client.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name')).rows.map(row => row.migration_name);
  record('All repository migrations are applied', JSON.stringify(migrations) === JSON.stringify(applied));
} catch {
  record('Configuration and database inspection completed', false);
} finally {
  await client?.end();
  await readiness?.readinessPool.end();
}
const passed = checks.length > 0 && checks.every(check => check.passed);
console.log(JSON.stringify({ passed, checks, manualGates: ['Office and privacy approval', 'Persistent volume survives redeployment', 'Backup schedule, separate storage and key custody', 'HTTPS/proxy, devices, messaging and monitoring acceptance'] }, null, 2));
if (!passed) process.exitCode = 1;
