// ============================================================================
// Embedded, per-client SFTP drop server.
//
// One process, one port. Each client authenticates with credentials issued
// by generateSftpCredentials() (admin_api.ts) and is confined to their own
// ingest folder — they can list and upload files there, and nothing else:
// no read of file contents, no delete, no rename, no escape to another
// client's folder or the host filesystem. This is deliberately a narrower
// surface than a general-purpose SFTP server, because the only legitimate
// operation here is "drop a file for us to pick up."
//
// Files land in the same folder integration/sweep.ts already sweeps, so
// nothing downstream of "a file appears in var/ingest/<client_id>" changes.
// ============================================================================

import { timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import type { PoolLike } from '../service.ts';
import { verifyPassword } from '../web/auth.ts';
import { provisionIngestFolder } from './sweep.ts';

const { Server, utils } = ssh2;
const { OPEN_MODE, STATUS_CODE } = utils.sftp;

// ---------------------------------------------------------------------------
// host key: the server's own identity, not a client credential. Generated
// once and persisted so returning clients don't see a "host key changed"
// warning on every restart.
// ---------------------------------------------------------------------------

export async function ensureHostKey(keyPath: string): Promise<Buffer> {
  if (existsSync(keyPath)) return readFile(keyPath);
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  await mkdir(path.dirname(keyPath), { recursive: true });
  await writeFile(keyPath, privateKey, { mode: 0o600 });
  return Buffer.from(privateKey);
}

// ---------------------------------------------------------------------------
// path confinement: every client-supplied path is resolved against that
// client's real folder root and rejected if it would escape it.
// ---------------------------------------------------------------------------

function resolveWithinRoot(root: string, clientPath: string): string | null {
  // client paths arrive as if root were "/" — normalize as posix, strip any
  // drive-letter-style or protocol tricks, then join onto the real root
  const normalized = path.posix.normalize('/' + clientPath).replace(/^\/+/, '/');
  const resolved = path.join(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

// ---------------------------------------------------------------------------
// auth: username -> client_integration row, scrypt-verify the password.
// Constant-shape comparison for the username lookup failure path too, so a
// non-existent username doesn't respond measurably faster than a wrong
// password for a real one.
// ---------------------------------------------------------------------------

interface ClientAuth {
  tenantId: string;
  clientId: string;
  clientName: string;
  passwordHash: string;
}

// a fixed, valid-shaped hash with no corresponding real password — used only
// to give the "username not found" path a real scrypt computation to run,
// see the authentication handler below.
const DUMMY_HASH = 's2:0000000000000000000000000000000000000000000000000000000000000000:'
  + '0'.repeat(64);

async function lookupClient(pool: PoolLike, username: string): Promise<ClientAuth | null> {
  const rows = await pool.query(
    `SELECT ci.tenant_id, ci.client_id, c.client_name, ci.sftp_inbound_password_hash
     FROM client_integration ci
     JOIN client c ON c.client_id = ci.client_id
     WHERE ci.sftp_inbound_username = $1 AND ci.sftp_inbound_enabled = true
       AND c.deleted_at IS NULL`,
    [username]);
  return rows.rows[0] ? {
    tenantId: rows.rows[0].tenant_id, clientId: rows.rows[0].client_id,
    clientName: rows.rows[0].client_name, passwordHash: rows.rows[0].sftp_inbound_password_hash,
  } : null;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export interface SftpServerOptions {
  port?: number;
  hostKeyPath?: string;
  log?: (msg: string) => void;
}

export async function startSftpServer(pool: PoolLike, opts: SftpServerOptions = {}) {
  const log = opts.log ?? ((m: string) => console.log(`[sftp] ${m}`));
  const hostKey = await ensureHostKey(
    opts.hostKeyPath ?? path.join(process.cwd(), 'var', 'sftp_host_key'),
  );

  // net.Server.close() (which this wraps) only stops accepting *new*
  // connections — it waits indefinitely for existing ones to close on their
  // own before its callback fires. A client that doesn't cleanly finish its
  // own teardown (a rejected-auth connection, an abrupt network drop) would
  // otherwise hang close() forever. Track connections ourselves and end them
  // explicitly when closing, same graceful-then-bounded pattern as the HTTP
  // server's shutdown in web/main.ts.
  const activeClients = new Set<import('ssh2').Connection>();

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    activeClients.add(client);
    client.on('close', () => activeClients.delete(client));

    let auth: ClientAuth | null = null;
    let root: string | null = null;

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      lookupClient(pool, ctx.username)
        .then(async (found) => {
          // verifyPassword() short-circuits on a null hash without ever
          // calling scrypt, so a nonexistent username would otherwise return
          // measurably faster than a real one with a wrong password — that
          // timing difference is enough to enumerate valid usernames. Always
          // run a real scrypt comparison against DUMMY_HASH in that case so
          // both paths cost the same.
          const ok = verifyPassword(ctx.password, found?.passwordHash ?? DUMMY_HASH);
          if (!found || !ok) return ctx.reject();

          // Resolve the client's folder *before* accepting: ssh2 requires
          // client.on('session', ...) to be registered synchronously inside
          // the 'ready' handler, or the client's channel-open request races
          // ahead of the listener and gets auto-rejected by ssh2 itself. So
          // there's no good place to await this after 'ready' fires — doing
          // it here, before accept(), means 'root' is already populated by
          // the time 'ready' happens and the session listener attaches
          // immediately as ssh2 expects.
          try {
            root = await provisionIngestFolder(pool, found.tenantId, found.clientId);
          } catch (err) {
            log(`folder provisioning failed: ${err instanceof Error ? err.message : err}`);
            return ctx.reject();
          }
          auth = found;
          ctx.accept();
        })
        .catch((err) => {
          log(`auth error: ${err instanceof Error ? err.message : err}`);
          ctx.reject();
        });
    });

    client.on('ready', () => {
      if (!auth || !root) return client.end();
      log(`${auth.clientName} connected`);

      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (accept: () => any) => {
          const sftp = accept();
          const openFiles = new Map<number, { fd: import('node:fs/promises').FileHandle; path: string }>();
          let nextHandle = 0;

          const reject = (reqid: number, code = STATUS_CODE.PERMISSION_DENIED) =>
            sftp.status(reqid, code);
          const resolveOrReject = (reqid: number, clientPath: string): string | null => {
            if (!root) { reject(reqid, STATUS_CODE.FAILURE); return null; }
            const real = resolveWithinRoot(root, clientPath);
            if (!real) { reject(reqid); return null; }
            return real;
          };

          sftp.on('REALPATH', (reqid: number, requestPath: string) => {
            const real = resolveOrReject(reqid, requestPath);
            if (!real) return;
            const virtual = '/' + path.relative(root!, real);
            sftp.name(reqid, [{ filename: virtual === '/' ? '/' : virtual, longname: virtual, attrs: {} }]);
          });

          sftp.on('OPENDIR', (reqid: number, requestPath: string) => {
            const real = resolveOrReject(reqid, requestPath);
            if (!real) return;
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(nextHandle, 0);
            openFiles.set(nextHandle, { fd: null as any, path: real });
            nextHandle += 1;
            sftp.handle(reqid, handle);
          });

          sftp.on('READDIR', (reqid: number, handleBuf: Buffer) => {
            const entry = openFiles.get(handleBuf.readUInt32BE(0));
            if (!entry) return reject(reqid, STATUS_CODE.FAILURE);
            if ((entry as any).listed) {
              // EOF, not an error — but the handle stays open. The client
              // still sends an explicit CLOSE for it afterward (standard
              // OPENDIR -> READDIR* -> CLOSE sequence); deleting it here
              // would make that CLOSE find nothing and fail spuriously.
              return reject(reqid, STATUS_CODE.EOF);
            }
            (entry as any).listed = true;
            readdir(entry.path, { withFileTypes: true })
              .then((files) => {
                const names = files
                  .filter((f) => f.isFile())
                  .map((f) => ({ filename: f.name, longname: f.name, attrs: {} }));
                if (names.length === 0) return reject(reqid, STATUS_CODE.EOF);
                sftp.name(reqid, names);
              })
              .catch(() => reject(reqid, STATUS_CODE.FAILURE));
          });

          sftp.on('LSTAT', statHandler);
          sftp.on('STAT', statHandler);
          function statHandler(reqid: number, requestPath: string) {
            const real = resolveOrReject(reqid, requestPath);
            if (!real) return;
            stat(real)
              .then((s) => sftp.attrs(reqid, {
                mode: s.mode, uid: 0, gid: 0, size: s.size,
                atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000),
              }))
              .catch(() => reject(reqid, STATUS_CODE.NO_SUCH_FILE));
          }

          sftp.on('OPEN', (reqid: number, requestPath: string, flags: number) => {
            if (!(flags & OPEN_MODE.WRITE)) {
              return reject(reqid, STATUS_CODE.OP_UNSUPPORTED); // upload-only: no read
            }
            const real = resolveOrReject(reqid, requestPath);
            if (!real) return;
            // no subdirectories from the client's side — keep the drop flat
            if (path.dirname(real) !== root) return reject(reqid);

            import('node:fs/promises').then(({ open }) =>
              open(real, 'w', 0o640)
                .then((fd) => {
                  const handle = Buffer.alloc(4);
                  handle.writeUInt32BE(nextHandle, 0);
                  openFiles.set(nextHandle, { fd, path: real });
                  nextHandle += 1;
                  sftp.handle(reqid, handle);
                })
                .catch(() => reject(reqid, STATUS_CODE.FAILURE)));
          });

          sftp.on('WRITE', (reqid: number, handleBuf: Buffer, offset: number, data: Buffer) => {
            const entry = openFiles.get(handleBuf.readUInt32BE(0));
            if (!entry?.fd) return reject(reqid, STATUS_CODE.FAILURE);
            entry.fd.write(data, 0, data.length, offset)
              .then(() => sftp.status(reqid, STATUS_CODE.OK))
              .catch(() => reject(reqid, STATUS_CODE.FAILURE));
          });

          sftp.on('CLOSE', (reqid: number, handleBuf: Buffer) => {
            const key = handleBuf.readUInt32BE(0);
            const entry = openFiles.get(key);
            openFiles.delete(key);
            if (!entry) return reject(reqid, STATUS_CODE.FAILURE);
            if (!entry.fd) return sftp.status(reqid, STATUS_CODE.OK); // dir handle
            entry.fd.close()
              .then(() => sftp.status(reqid, STATUS_CODE.OK))
              .catch(() => reject(reqid, STATUS_CODE.FAILURE));
          });

          // upload-only: everything that mutates or reveals existing files
          // beyond a bare listing is explicitly refused with a real response
          // (not left unhandled, which would just hang the client waiting)
          for (const op of [
            'READ', 'REMOVE', 'RENAME', 'MKDIR', 'RMDIR', 'SETSTAT',
            'SYMLINK', 'READLINK', 'FSTAT', 'FSETSTAT',
          ]) {
            sftp.on(op, (reqid: number) => reject(reqid, STATUS_CODE.OP_UNSUPPORTED));
          }
        });
      });
    });

    client.on('close', () => {
      if (auth) log(`${auth.clientName} disconnected`);
    });
    client.on('error', (err) => log(`client error: ${err.message}`));
  });

  const requestedPort = opts.port ?? (Number(process.env.SFTP_PORT) || 2222);
  await new Promise<void>((resolve) => server.listen(requestedPort, '0.0.0.0', resolve));
  // requestedPort may be 0 (OS picks a free port, e.g. in tests) — read back
  // the port actually bound, the same way web/server.ts does for HTTP
  const boundPort = (server.address() as import('node:net').AddressInfo).port;
  log(`listening on port ${boundPort}`);

  return {
    server,
    port: boundPort,
    close: async () => {
      const graceful = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const c of activeClients) c.end();
      // bounded wait: server.close()'s callback only fires once every
      // existing connection has finished closing, which can hang if one
      // doesn't tear down cleanly on its own — force-move-on rather than
      // block the caller (e.g. a graceful shutdown handler) forever
      await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, 2000))]);
    },
  };
}

// re-exported so callers (and tests) don't need their own `ssh2` import just
// to reference the utility that turns a PEM string into an ssh2 key object
// when acting as a test client against this server
export const parseKey = utils.parseKey;
