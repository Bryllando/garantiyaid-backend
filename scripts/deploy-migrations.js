import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrationEnvironment(environment) {
  assert.ok(environment.MIGRATION_DATABASE_URL, 'A separate MIGRATION_DATABASE_URL is required.');
  const runtime = new URL(environment.DATABASE_URL), migration = new URL(environment.MIGRATION_DATABASE_URL);
  for (const connection of [runtime, migration]) assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol), 'PostgreSQL URLs are required.');
  assert.equal(migration.host, runtime.host, 'Migration and runtime must target the same database endpoint.');
  assert.equal(migration.pathname, runtime.pathname, 'Migration and runtime must target the same database.');
  assert.equal(migration.searchParams.get('schema') || 'public', runtime.searchParams.get('schema') || 'public', 'Migration and runtime must target the same schema.');
  assert.notEqual(decodeURIComponent(migration.username), decodeURIComponent(runtime.username), 'Use separate migration and runtime roles.');
  return { ...environment, DATABASE_URL: environment.MIGRATION_DATABASE_URL };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const environment = migrationEnvironment(process.env);
    const code = await new Promise((accept, reject) => {
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], { env: environment, windowsHide: true, stdio: 'ignore' });
      child.once('error', reject); child.once('exit', accept);
    });
    assert.equal(code, 0, 'Migration failed.');
    console.log('Deployment migrations applied.');
  } catch {
    console.error('Deployment migrations failed. Check separate runtime/migration credentials, matching target database, database access and migration history before restarting deployment.');
    process.exitCode = 1;
  }
}
