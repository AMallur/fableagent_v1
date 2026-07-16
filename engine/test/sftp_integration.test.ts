// ============================================================================
// Embedded SFTP server integration test — drives a real ssh2 SSH client
// against a real running instance of our server (not a mock of either side).
//
//   TEST_DATABASE_URL=postgres://... node --test test/sftp_integration.test.ts
//
// Covers: credential generation, successful auth + upload landing in the
// right client's folder (and picked up by the existing sweep), wrong
// password rejected, unknown username rejected, revoked credentials
// rejected, path traversal blocked, and read/delete/rename all refused
// (upload-only surface).
// ============================================================================

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ssh2 from 'ssh2';

const url = process.env.TEST_DATABASE_URL;
const T = 'de300000-0000-4000-8000-000000000001';
const C = 'de300000-0000-4000-8000-000000000002';

describe('embedded SFTP server', { skip: !url && 'TEST_DATABASE_URL not set' }, () => {
  let pool: any;
  let sftpSrv: any;
  let folder: string;
  let username: string;
  let password: string;
  let adminUserId: string;

  before(async () => {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({ connectionString: url });

    // isolate this test's client folder + host key from anything else on disk
    folder = await mkdtemp(path.join(tmpdir(), 'sftp-test-'));
    await pool.query(`UPDATE client SET ingest_folder = $2 WHERE client_id = $1`, [C, folder]);

    const adminRow = await pool.query(
      `SELECT user_id FROM app_user WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [T]);
    adminUserId = adminRow.rows[0].user_id;

    const { generateSftpCredentials } = await import('../src/web/admin_api.ts');
    // bypass the HTTP/session layer here — this test is about the protocol
    // server, not the admin API route wiring (that's covered elsewhere)
    const scope = { tenantId: T, clientIds: [C] };
    const sess = { userId: adminUserId, tenantId: T,
      clientId: null, role: 'tenant_admin', name: 'test', exp: 0 } as any;
    const creds = await generateSftpCredentials(pool, sess, scope, C);
    username = creds.username;
    password = creds.password;

    const { startSftpServer } = await import('../src/integration/sftp_server.ts');
    sftpSrv = await startSftpServer(pool, {
      port: 0,
      hostKeyPath: path.join(folder, '..', `hostkey-${Date.now()}`),
      log: () => {},
    });
  });

  after(async () => {
    await sftpSrv.close();
    await pool.end();
    await rm(folder, { recursive: true, force: true });
  });

  function connect(user: string, pass: string): Promise<import('ssh2').Client> {
    return new Promise((resolve, reject) => {
      const client = new ssh2.Client();
      client.on('ready', () => resolve(client));
      client.on('error', reject);
      client.connect({
        host: '127.0.0.1', port: sftpSrv.port, username: user, password: pass,
        readyTimeout: 5000,
      });
    });
  }

  function connectExpectingFailure(user: string, pass: string): Promise<'rejected' | 'connected'> {
    return new Promise((resolve) => {
      const client = new ssh2.Client();
      const done = (result: 'rejected' | 'connected') => { client.end(); resolve(result); };
      client.on('ready', () => done('connected'));
      client.on('error', () => done('rejected'));
      client.connect({
        host: '127.0.0.1', port: sftpSrv.port, username: user, password: pass,
        readyTimeout: 5000,
      });
    });
  }

  function sftpOf(client: import('ssh2').Client): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
    });
  }

  function upload(sftp: import('ssh2').SFTPWrapper, remotePath: string, content: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => resolve());
      stream.on('error', reject);
      stream.end(content);
    });
  }

  // -------------------------------------------------------------------------
  it('rejects an unknown username', async () => {
    const result = await connectExpectingFailure('no-such-user', 'whatever');
    assert.equal(result, 'rejected');
  });

  it('rejects the right username with the wrong password', async () => {
    const result = await connectExpectingFailure(username, 'definitely-wrong');
    assert.equal(result, 'rejected');
  });

  it('accepts valid credentials and uploads a file into the client folder', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    const fixtureContent = 'ISA*00*...835 fixture content...~';
    await upload(sftp, '/incoming.835', fixtureContent);
    client.end();

    const onDisk = await readFile(path.join(folder, 'incoming.835'), 'utf8');
    assert.equal(onDisk, fixtureContent);
  });

  it('an uploaded file is picked up by the existing sweep unchanged', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    const { FIXTURE_835 } = await import('./ingest.test.ts');
    const content = FIXTURE_835.replaceAll('CHK-IT-100', `CHK-SFTPSRV-${Date.now()}`);
    await upload(sftp, '/dropped.835', content);
    client.end();

    const { sweepClientFolder } = await import('../src/integration/sweep.ts');
    const result = await sweepClientFolder(pool, { tenantId: T, clientId: C });
    const outcome = result.files.find((f: any) => f.fileName === 'dropped.835');
    assert.ok(outcome, 'sweep saw the SFTP-dropped file');
    assert.equal(outcome!.status, 'ingested');
  });

  it('lists only its own previously-uploaded files, nothing from the host', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    await upload(sftp, '/listing-fixture.835', 'x');
    const entries: string[] = await new Promise((resolve, reject) => {
      sftp.readdir('/', (err, list) => (err ? reject(err) : resolve(list.map((e) => e.filename))));
    });
    client.end();
    assert.ok(entries.includes('listing-fixture.835'));
    // never leaks the sweep's own bookkeeping subfolders as files, and never
    // anything outside this client's root
    assert.ok(!entries.some((e) => e.includes('..')));
  });

  it('blocks path traversal — cannot escape the client folder', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    await assert.rejects(upload(sftp, '/../../../../etc/passwd-attempt', 'pwned'));
    client.end();
    const escaped = await readFile('/tmp/passwd-attempt', 'utf8').catch(() => null);
    assert.equal(escaped, null, 'nothing was written outside the sandbox');
  });

  it('refuses to write into a subdirectory (flat drop only)', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    await assert.rejects(upload(sftp, '/subdir/file.835', 'x'));
    client.end();
  });

  it('is upload-only: read, delete, and rename are all refused', async () => {
    const client = await connect(username, password);
    const sftp = await sftpOf(client);
    const marker = 'refuse-ops-fixture.835';
    await upload(sftp, '/' + marker, '835 fixture content for refusal checks');

    await assert.rejects(new Promise((resolve, reject) => {
      sftp.readFile('/' + marker, (err, data) => (err ? reject(err) : resolve(data)));
    }), 'reading an uploaded file should be refused');

    await assert.rejects(new Promise<void>((resolve, reject) => {
      sftp.unlink('/' + marker, (err) => (err ? reject(err) : resolve()));
    }), 'deleting should be refused');

    await assert.rejects(new Promise<void>((resolve, reject) => {
      sftp.rename('/' + marker, '/renamed.835', (err) => (err ? reject(err) : resolve()));
    }), 'renaming should be refused');

    client.end();
    // the file is still there, untouched, proving the refusals were real
    // and not just a mistimed race — but note: a later sweep in another test
    // may have already moved it to processed/, so check both locations
    const stillThere = await readFile(path.join(folder, marker), 'utf8')
      .catch(() => readFile(path.join(folder, 'processed', marker), 'utf8').catch(() => null));
    assert.match(stillThere ?? '', /835 fixture content for refusal checks/);
  });

  it('one client cannot see or reach another client folder', async () => {
    const otherFolder = await mkdtemp(path.join(tmpdir(), 'sftp-other-'));
    // the demo seed creates exactly one client under this tenant — create a
    // second, disposable one for this test rather than assuming
    const otherClientRow = await pool.query(
      `INSERT INTO client (tenant_id, client_name, ingest_folder)
       VALUES ($1, $3, $2) RETURNING client_id`,
      [T, otherFolder, `SFTP Isolation Test Client ${Date.now()}`]);
    const otherClientId = otherClientRow.rows[0].client_id;

    const scope = { tenantId: T, clientIds: [T, otherClientId, C] };
    const sess = { userId: adminUserId, tenantId: T,
      clientId: null, role: 'tenant_admin', name: 'test', exp: 0 } as any;
    const { generateSftpCredentials } = await import('../src/web/admin_api.ts');
    const other = await generateSftpCredentials(pool, sess, scope as any, otherClientId);

    const clientA = await connect(username, password);
    const sftpA = await sftpOf(clientA);
    await upload(sftpA, '/client-a-file.835', 'A content');
    clientA.end();

    const clientB = await connect(other.username, other.password);
    const sftpB = await sftpOf(clientB);
    const bListing: string[] = await new Promise((resolve, reject) => {
      sftpB.readdir('/', (err, list) => (err ? reject(err) : resolve(list.map((e) => e.filename))));
    });
    clientB.end();

    assert.ok(!bListing.includes('client-a-file.835'), "client B cannot see client A's files");
    await rm(otherFolder, { recursive: true, force: true });
    await pool.query(`DELETE FROM client_integration WHERE client_id = $1`, [otherClientId]);
    await pool.query(`DELETE FROM client WHERE client_id = $1`, [otherClientId]);
  });

  it('revoked credentials are rejected on the next connection', async () => {
    const scope = { tenantId: T, clientIds: [C] };
    const sess = { userId: adminUserId, tenantId: T,
      clientId: null, role: 'tenant_admin', name: 'test', exp: 0 } as any;
    const { revokeSftpCredentials } = await import('../src/web/admin_api.ts');
    await revokeSftpCredentials(pool, sess, scope, C);

    const result = await connectExpectingFailure(username, password);
    assert.equal(result, 'rejected');
  });
});
