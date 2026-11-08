import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(backend, '..');
const databaseName = `garantiyaid_acceptance_${randomUUID().replaceAll('-', '')}`;
assert.match(databaseName, /^garantiyaid_acceptance_[a-f0-9]{32}$/);
const pilot = process.argv.includes('--pilot');
const burial = process.argv.includes('--burial');
assert.ok(!(pilot && burial), 'Run burial and supervised-pilot checks separately.');
const output = resolve(root, burial ? 'output/burial-referrals' : pilot ? 'output/pilot-acceptance' : 'output/integrated-acceptance');
const workspace = resolve(root, 'tmp', databaseName);
await mkdir(output, { recursive: true });
await mkdir(workspace, { recursive: true });
const pgBin = process.env.PG_BIN || 'C:/Program Files/PostgreSQL/18/bin';
const pgExecutable = (name) => resolve(pgBin, `${name}${process.platform === 'win32' ? '.exe' : ''}`);
const pgData = resolve(workspace, 'postgres');
const passwordFile = resolve(workspace, 'postgres-password');
const dbPassword = randomBytes(24).toString('hex');
await writeFile(passwordFile, dbPassword);
const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const pgPort = portProbe.address().port;
await new Promise(done => portProbe.close(done));
const connection = new URL(`postgresql://acceptance:${dbPassword}@127.0.0.1:${pgPort}/${databaseName}`);
const maintenanceConnection = new URL(connection); maintenanceConnection.pathname = '/postgres';
let maintenance = new pg.Client({ connectionString: maintenanceConnection.toString() });
async function command(executable, args, cwd = workspace) {
  const child = spawn(executable, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
  const [code] = await once(child, 'exit');
  await appendFile(resolve(output, 'setup.log'), log);
  if (code !== 0) console.error(log);
  assert.equal(code, 0, `${executable} failed.`);
}
Object.assign(process.env, {
  DATABASE_URL: connection.toString(), NODE_ENV: 'test', ENFORCE_HTTPS: 'false',
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'), JWT_ACCESS_EXPIRES_IN: '1h',
  FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  UPLOAD_ROOT: resolve(workspace, 'persistent-uploads'),
  EMAIL_PROVIDER_MODE: 'DISABLED', SMS_PROVIDER_MODE: 'SIMULATED', BIOMETRIC_PROCESSOR_MODE: 'SIMULATED',
  API_RATE_LIMIT_PER_15_MINUTES: '10000', BIOMETRIC_RATE_LIMIT_PER_15_MINUTES: '200',
  AUTH_RATE_LIMIT_PER_15_MINUTES: '100',
  CORS_ORIGIN: 'http://127.0.0.1:5173',
  VITE_API_URL: '/api/v1',
});
let created = false;
// shortcut: a forced termination may leave the temporary instance; add signal cleanup before unattended CI use.
let postgresStarted = false;
let server;
let io;
let prisma;
let readinessClosed = false;
const report = { startedAt: new Date().toISOString(), database: databaseName, checks: [], simulation: burial ? ['synthetic applicants, documents, signatories and office responses; no actual signature or office submission'] : ['face processor', 'wallet settlement', 'SMS'], passed: false };
try {
  await writeFile(resolve(output, 'setup.log'), '');
  await rm(resolve(output, 'failure.png'), { force: true });
  await command(pgExecutable('initdb'), ['-D', pgData, '-U', 'acceptance', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C']);
  await command(pgExecutable('pg_ctl'), ['-D', pgData, '-l', resolve(workspace, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort}`, '-w', 'start']);
  postgresStarted = true;
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  console.log('Created isolated acceptance database. Applying repository migrations.');
  await command(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], backend);
  // Uploads resolve from cwd; keep every synthetic file in this run's own directory.
  process.chdir(workspace);
  prisma = (await import('../src/lib/prisma.js')).default;
  const app = (await import('../src/app.js')).default;
  server = app.listen(0, '127.0.0.1');
  io = (await import('../src/realtime/socket.js')).attachRealtimeServer(server);
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (burial) {
    const { runBurialCases } = await import('./burial-referral-cases.js');
    const state = await runBurialCases({ prisma, baseUrl, report });
    const { runBurialJourney } = await import('../../garantiyaid-frontend/scripts/verify-burial-referrals.mjs');
    await runBurialJourney({ ...state, prisma, baseUrl, output, report });
  } else {
    const { runIntegratedCases } = await import('./integrated-workflow-cases.js');
    const state = await runIntegratedCases({ prisma, baseUrl, report });
    const { runStaffJourney } = await import('../../garantiyaid-frontend/scripts/integrated-staff-journey.mjs');
    await runStaffJourney({ ...state, prisma, baseUrl, output, report });
  }
  if (pilot) {
    const { runPilotRecovery } = await import('./verify-pilot-recovery.js');
    await runPilotRecovery({ prisma, baseUrl, workspace, connection: connection.toString(), maintenance, databaseName, report,
      restartDatabase: async (action) => {
        if (action === 'stop') await command(pgExecutable('pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
        else {
          await command(pgExecutable('pg_ctl'), ['-D', pgData, '-l', resolve(workspace, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort}`, '-w', 'start']);
          maintenance = new pg.Client({ connectionString: maintenanceConnection.toString() });
          await maintenance.connect();
        }
      },
      stopApi: async () => {
        (await import('../src/realtime/socket.js')).clearRealtimePublisher(io);
        await new Promise(done => io.close(done)); io = null;
        server.closeAllConnections();
        await new Promise(done => server.close(done)); server = null;
        await (await import('../src/lib/readiness.js')).readinessPool.end();
        readinessClosed = true;
      },
    });
  }
  report.passed = true;
  console.log(`Integrated acceptance passed: ${report.checks.length} checks.`);
} catch (error) {
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  if (io) { (await import('../src/realtime/socket.js')).clearRealtimePublisher(io); await new Promise(done => io.close(done)); }
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
  await prisma?.$disconnect();
  if (!readinessClosed) await (await import('../src/lib/readiness.js')).readinessPool.end();
  process.chdir(backend);
  if (created) {
    // Only this process's freshly created database is eligible for cleanup.
    assert.match(databaseName, /^garantiyaid_acceptance_[a-f0-9]{32}$/);
    await maintenance.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    report.databaseRemoved = true;
  }
  await maintenance.end();
  if (postgresStarted) await command(pgExecutable('pg_ctl'), ['-D', pgData, '-m', 'fast', '-w', 'stop']);
  assert.equal(workspace, resolve(root, 'tmp', databaseName));
  assert.ok(workspace.startsWith(`${resolve(root, 'tmp')}${process.platform === 'win32' ? '\\' : '/'}`));
  await rm(workspace, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
}
