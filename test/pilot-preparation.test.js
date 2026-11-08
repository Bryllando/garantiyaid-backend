import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkReadiness } from '../src/lib/readiness.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { enforceHttps } from '../src/middleware/security.js';
import { migrationEnvironment } from '../scripts/deploy-migrations.js';
import { maintenanceResponse } from '../scripts/pilot-maintenance.js';
import { env } from '../src/config/env.js';
import { resolveBeneficiaryDocumentPath } from '../src/modules/documents/beneficiaryDocument.service.js';
import { encryptFile, decryptFile, validateManifest } from '../scripts/pilot-backup.js';

test('backup encryption rejects the wrong key, changed contents and swapped member names', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'garantiyaid-crypto-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = randomBytes(32).toString('hex');
  await writeFile(join(dir, 'source'), 'synthetic private evidence');
  await encryptFile(join(dir, 'source'), join(dir, 'encrypted'), key, 'database.dump');
  assert.equal((await readFile(join(dir, 'encrypted'))).includes(Buffer.from('synthetic')), false);
  await decryptFile(join(dir, 'encrypted'), join(dir, 'restored'), key, 'database.dump');
  assert.equal(await readFile(join(dir, 'restored'), 'utf8'), 'synthetic private evidence');
  await assert.rejects(decryptFile(join(dir, 'encrypted'), join(dir, 'wrong-key'), randomBytes(32).toString('hex'), 'database.dump'));
  await assert.rejects(decryptFile(join(dir, 'encrypted'), join(dir, 'wrong-name'), key, 'field-key.json'));
  const damaged = await readFile(join(dir, 'encrypted')); damaged[20] ^= 1;
  await writeFile(join(dir, 'damaged'), damaged);
  await assert.rejects(decryptFile(join(dir, 'damaged'), join(dir, 'wrong-data'), key, 'database.dump'));
});

test('recovery manifest rejects traversal, duplicate members and incomplete bundles', () => {
  const sha256 = 'a'.repeat(64);
  const manifest = { version: 1, counts: { _prisma_migrations: '33' }, files: [{ path: 'database.dump', sha256 }, { path: 'field-key.json', sha256 }] };
  assert.doesNotThrow(() => validateManifest(manifest));
  for (const path of ['../.env', 'uploads/beneficiary-documents/../../secret', 'C:/private', '/private']) {
    assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, { path, sha256 }] }));
  }
  assert.throws(() => validateManifest({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
  assert.throws(() => validateManifest({ ...manifest, files: [manifest.files[0]] }));
});

test('readiness requires a database response and writable evidence storage; probes leave no files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'garantiyaid-readiness-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await checkReadiness({ query: async sql => { assert.equal(sql, 'SELECT 1'); } }, dir);
  assert.deepEqual(await readdir(dir), []);
  await assert.rejects(checkReadiness({ query: async () => { throw new Error('database unavailable'); } }, dir));
  await assert.rejects(checkReadiness({ query: async () => {} }, join(dir, 'missing')));
});

test('stored document keys remain portable and contained under the configured private volume', () => {
  const key = 'uploads/beneficiary-documents/11111111-1111-4111-8111-111111111111.pdf';
  assert.equal(resolveBeneficiaryDocumentPath(key), join(env.uploadRoot, 'beneficiary-documents', key.split('/').at(-1)));
  for (const value of ['../.env', 'uploads/beneficiary-documents/../secret', 'uploads/beneficiary-documents/C:secret', 'uploads/beneficiary-documents/..\\secret', null]) {
    assert.throws(() => resolveBeneficiaryDocumentPath(value), error => error.code === 'INVALID_DOCUMENT_PATH');
  }
});

test('production exception logs omit query values, payloads and stack traces', () => {
  const previous = process.env.NODE_ENV, original = console.error;
  const logs = [];
  process.env.NODE_ENV = 'production'; console.error = value => logs.push(value);
  try {
    const response = { status() { return this; }, json(body) { assert.equal(body.error.message, 'An unexpected server error occurred.'); } };
    errorHandler(new Error('private internal data'), { method: 'GET', path: '/records', originalUrl: '/records?token=private-reset-token&name=private-person', requestId: 'test', body: { password: 'private-password' } }, response, () => {});
    assert.equal(logs[0].path, '/records');
    assert.doesNotMatch(JSON.stringify(logs), /private|stack|token=|name=/);
  } finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; console.error = original; }
});

test('only data-free health probes bypass HTTPS enforcement', () => {
  for (const path of ['/api/v1/health', '/api/v1/health/ready']) {
    enforceHttps({ method: 'GET', path, secure: false }, {}, error => assert.equal(error, undefined));
  }
  for (const request of [{ method: 'POST', path: '/api/v1/health' }, { method: 'GET', path: '/api/v1/users' }, { method: 'GET', path: '/api/v1/health/ready/private' }]) {
    enforceHttps({ ...request, secure: false }, {}, error => assert.equal(error.code, 'HTTPS_REQUIRED'));
  }
});

test('deployment migrations require a distinct role on the runtime database', () => {
  const environment = { DATABASE_URL: 'postgresql://runtime:fake@localhost/app', MIGRATION_DATABASE_URL: 'postgresql://migrator:fake@localhost/app' };
  assert.equal(migrationEnvironment(environment).DATABASE_URL, environment.MIGRATION_DATABASE_URL);
  assert.throws(() => migrationEnvironment({ DATABASE_URL: environment.DATABASE_URL }));
  assert.throws(() => migrationEnvironment({ ...environment, MIGRATION_DATABASE_URL: environment.DATABASE_URL }));
  assert.throws(() => migrationEnvironment({ ...environment, MIGRATION_DATABASE_URL: 'postgresql://migrator:fake@localhost/another_database' }));
  assert.throws(() => migrationEnvironment({ ...environment, MIGRATION_DATABASE_URL: 'postgresql://%72untime:fake@localhost/app' }));
  assert.throws(() => migrationEnvironment({ ...environment, MIGRATION_DATABASE_URL: 'postgresql://migrator:fake@localhost/app?schema=other' }));
  assert.throws(() => migrationEnvironment({ ...environment, MIGRATION_DATABASE_URL: 'https://migrator:fake@localhost/app' }));
});

test('maintenance accepts only its data-free probe and rejects staff reads and writes', () => {
  for (const [method, url, expected] of [['GET', '/maintenance-health', 200], ['POST', '/maintenance-health', 503], ['GET', '/api/v1/health/ready', 503], ['POST', '/api/v1/distributions/event/claims/claim/release', 503]]) {
    maintenanceResponse({ method, url }, { writeHead(code, headers) { assert.equal(code, expected); assert.equal(headers['Cache-Control'], 'no-store'); }, end(body) { assert.doesNotMatch(body, /password|token|database/); } });
  }
});
