import 'dotenv/config';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';

const magic = Buffer.from('GYABK1');
const hexKey = /^[a-f0-9]{64}$/i;
const documentPath = /^uploads\/beneficiary-documents\/([a-zA-Z0-9][a-zA-Z0-9._-]*)$/;
const quote = value => `"${value.replaceAll('"', '""')}"`;
const pgBin = process.env.PG_BIN || (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/18/bin' : '/usr/bin');

function keyBytes(key) {
  assert.match(key || '', hexKey, 'BACKUP_ENCRYPTION_KEY must contain 64 hexadecimal characters.');
  return Buffer.from(key, 'hex');
}

export async function encryptFile(source, target, key, label) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from(label));
  await writeFile(target, Buffer.concat([magic, iv]), { flag: 'wx', mode: 0o600 });
  await pipeline(createReadStream(source), cipher, createWriteStream(target, { flags: 'a' }));
  await appendFile(target, cipher.getAuthTag());
}

export async function decryptFile(source, target, key, label) {
  const stat = await lstat(source);
  assert.ok(stat.isFile() && stat.size >= 34, 'Backup member is not a regular encrypted file.');
  const file = await open(source, 'r');
  const header = Buffer.alloc(18), tag = Buffer.alloc(16);
  try { await file.read(header, 0, 18, 0); await file.read(tag, 0, 16, stat.size - 16); }
  finally { await file.close(); }
  assert.ok(header.subarray(0, 6).equals(magic), 'Unsupported backup format.');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), header.subarray(6));
  decipher.setAAD(Buffer.from(label));
  decipher.setAuthTag(tag);
  // Decrypt only into this operation's private staging directory; authenticate before restoring anything.
  await pipeline(createReadStream(source, { start: 18, end: stat.size - 17 }), decipher, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function databaseConnection(value) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'A PostgreSQL connection URL is required.');
  for (const name of url.searchParams.keys()) {
    assert.ok(['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'connect_timeout', 'channel_binding'].includes(name), 'Unsupported database URL parameter.');
  }
  const password = decodeURIComponent(url.password);
  url.password = '';
  url.searchParams.set('connect_timeout', '10');
  return { url: url.toString(), password };
}

async function pgCommand(name, args, connection) {
  const executable = join(pgBin, name + (process.platform === 'win32' ? '.exe' : ''));
  const safe = databaseConnection(connection);
  await new Promise((accept, reject) => {
    const child = spawn(executable, [...args, '--dbname', safe.url], {
      env: { ...process.env, PGPASSWORD: safe.password }, windowsHide: true, stdio: 'ignore',
    });
    child.once('error', () => reject(new Error(`${name} could not start; check PG_BIN and permissions.`)));
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`${name} failed; backup/restore was not accepted.`)));
  });
}

async function rowCounts(client) {
  const { rows } = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename");
  const counts = {};
  for (const { tablename } of rows) {
    counts[tablename] = (await client.query(`SELECT count(*)::text AS count FROM public.${quote(tablename)}`)).rows[0].count;
  }
  return counts;
}

export function validateManifest(manifest) {
  assert.equal(manifest.version, 1, 'Unsupported backup version.');
  assert.ok(Array.isArray(manifest.files) && manifest.files.length >= 2, 'Incomplete backup manifest.');
  const paths = new Set();
  for (const item of manifest.files) {
    assert.ok(['database.dump', 'field-key.json'].includes(item.path) || documentPath.test(item.path), 'Invalid backup member path.');
    assert.ok(!paths.has(item.path), 'Duplicate backup member.');
    paths.add(item.path);
    assert.match(item.sha256, hexKey, 'Invalid backup checksum.');
  }
  assert.ok(paths.has('database.dump') && paths.has('field-key.json'), 'Backup database or field key is missing.');
  assert.ok(manifest.counts && typeof manifest.counts === 'object' && manifest.counts._prisma_migrations, 'Missing database verification counts.');
}

async function temporaryWork(action) {
  const parent = resolve(tmpdir());
  const workspace = await mkdtemp(join(parent, 'garantiyaid-backup-'));
  try { return await action(workspace); }
  finally {
    assert.equal(dirname(workspace), parent);
    assert.ok(basename(workspace).startsWith('garantiyaid-backup-'));
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function createBackup({ destination, databaseUrl, uploadRoot, fieldKey, backupKey, writersStopped }) {
  assert.equal(writersStopped, true, 'Stop all API/worker/import writers, then use --writers-stopped.');
  keyBytes(backupKey);
  assert.match(fieldKey || '', hexKey, 'FIELD_ENCRYPTION_KEY is required.');
  assert.notEqual(fieldKey.toLowerCase(), backupKey.toLowerCase(), 'Use a separate backup encryption key.');
  databaseConnection(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const manifest = { version: 1, createdAt: new Date().toISOString(), counts: await rowCounts(client), files: [] };
    assert.ok(manifest.counts._prisma_migrations, 'Source is not an initialized GarantiyAid database.');
    const documents = (await client.query('SELECT file_path, checksum FROM beneficiary_documents ORDER BY document_id')).rows;
    await mkdir(destination, { mode: 0o700 });
    await temporaryWork(async workspace => {
      await pgCommand('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', join(workspace, 'database.dump')], databaseUrl);
      await writeFile(join(workspace, 'field-key.json'), JSON.stringify({ FIELD_ENCRYPTION_KEY: fieldKey }), { flag: 'wx', mode: 0o600 });
      const members = [{ path: 'database.dump', source: join(workspace, 'database.dump') }, { path: 'field-key.json', source: join(workspace, 'field-key.json') }];
      for (const document of documents) {
        assert.ok(documentPath.test(document.file_path), 'Document has an invalid storage path.');
        const source = join(uploadRoot, document.file_path.slice('uploads/'.length));
        assert.ok((await lstat(source)).isFile(), 'Document is missing or is not a regular file.');
        assert.equal(await fileHash(source), document.checksum, 'Document checksum differs from its saved evidence.');
        if (!members.some(item => item.path === document.file_path)) members.push({ path: document.file_path, source, checksum: document.checksum });
      }
      for (const member of members) {
        const target = join(destination, `${member.path}.enc`);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const sha256 = await fileHash(member.source);
        if (member.checksum) assert.equal(sha256, member.checksum, 'Document changed during backup.');
        await encryptFile(member.source, target, backupKey, member.path);
        assert.equal(await fileHash(member.source), sha256, 'File changed during backup.');
        manifest.files.push({ path: member.path, sha256 });
      }
      assert.deepEqual(await rowCounts(client), manifest.counts, 'Database changed during backup; stop writers and start a new backup.');
      await writeFile(join(workspace, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
      // Publishing the authenticated manifest last marks a complete backup.
      await encryptFile(join(workspace, 'manifest.json'), join(destination, 'manifest.enc'), backupKey, 'manifest');
    });
    return { createdAt: manifest.createdAt, documents: documents.length, tables: Object.keys(manifest.counts).length };
  } finally { await client.end(); }
}

export async function restoreBackup({ source, destination, databaseUrl, backupKey }) {
  keyBytes(backupKey);
  databaseConnection(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    const occupied = await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' LIMIT 1");
    assert.equal(occupied.rowCount, 0, 'Restore refuses a nonempty database. Provision a separate empty recovery database.');
    await mkdir(destination, { mode: 0o700 });
    return await temporaryWork(async workspace => {
      await decryptFile(join(source, 'manifest.enc'), join(workspace, 'manifest.json'), backupKey, 'manifest');
      const manifest = JSON.parse(await readFile(join(workspace, 'manifest.json'), 'utf8'));
      validateManifest(manifest);
      for (const item of manifest.files) {
        const target = join(workspace, item.path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await decryptFile(join(source, `${item.path}.enc`), target, backupKey, item.path);
        assert.equal(await fileHash(target), item.sha256, 'Backup member checksum failed.');
      }
      const keys = JSON.parse(await readFile(join(workspace, 'field-key.json'), 'utf8'));
      assert.match(keys.FIELD_ENCRYPTION_KEY, hexKey, 'Invalid recovery field key.');
      await pgCommand('pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', join(workspace, 'database.dump')], databaseUrl);
      assert.deepEqual(await rowCounts(client), manifest.counts, 'Restored table counts differ from the backup. Do not start the API.');
      // Older backups must not reactivate sessions, reset links or already-used recovery codes.
      await client.query('BEGIN');
      try {
        await client.query('UPDATE staff_sessions SET revoked_at = now() WHERE revoked_at IS NULL');
        await client.query('UPDATE staff_password_reset_tokens SET used_at = now() WHERE used_at IS NULL');
        await client.query('UPDATE staff_recovery_codes SET used_at = now() WHERE used_at IS NULL');
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      await mkdir(join(destination, 'uploads', 'beneficiary-documents'), { recursive: true, mode: 0o700 });
      for (const item of manifest.files.filter(item => documentPath.test(item.path))) {
        await cp(join(workspace, item.path), join(destination, item.path), { force: false, errorOnExist: true });
      }
      await cp(join(workspace, 'field-key.json'), join(destination, 'field-key.json'), { force: false, errorOnExist: true });
      const result = { backupCreatedAt: manifest.createdAt, restoredAt: new Date().toISOString(), tables: Object.keys(manifest.counts).length, documents: manifest.files.length - 2, sessionsAndRecoveryTokensRevoked: true };
      await writeFile(join(destination, 'restore-result.json'), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
      return result;
    });
  } finally { await client.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [operation, first, second, ...rest] = process.argv.slice(2);
    let result;
    if (operation === 'create' && first && second === '--writers-stopped' && rest.length === 0) {
      result = await createBackup({ destination: resolve(first), databaseUrl: process.env.DATABASE_URL, uploadRoot: resolve(process.env.UPLOAD_ROOT || 'uploads'), fieldKey: process.env.FIELD_ENCRYPTION_KEY, backupKey: process.env.BACKUP_ENCRYPTION_KEY, writersStopped: true });
    } else if (operation === 'restore' && first && second && rest.length === 0) {
      result = await restoreBackup({ source: resolve(first), destination: resolve(second), databaseUrl: process.env.RESTORE_DATABASE_URL, backupKey: process.env.BACKUP_ENCRYPTION_KEY });
    } else throw new Error('Use create <new-backup-directory> --writers-stopped OR restore <backup-directory> <new-recovery-directory>.');
    console.log(JSON.stringify({ success: true, ...result }));
  } catch {
    console.error('Backup/recovery failed. No result is accepted. Check the runbook, configuration, file permissions and PostgreSQL availability; retain failed artifacts privately for review.');
    process.exitCode = 1;
  }
}
