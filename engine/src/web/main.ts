// Entry point: DATABASE_URL=postgres://... node src/web/main.ts [--port 8787]
import { readFileSync } from 'node:fs';
import { startServer } from './server.ts';
import { pgSslConfig } from './db_ssl.ts';

const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/rcm_dev',
  ssl: pgSslConfig(readFileSync),
});

const portArg = process.argv.indexOf('--port');
const srv = await startServer(pool, {
  port: portArg > -1 ? Number(process.argv[portArg + 1]) : undefined,
});
console.log(`RCM Recovery interface listening on http://localhost:${srv.port}`);

// graceful shutdown: stop accepting new connections, let in-flight requests
// finish, then release the pool — so a `docker stop` / rolling deploy
// doesn't drop requests mid-flight or leave connections dangling.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down…`);
  const forceExit = setTimeout(() => {
    console.error('shutdown timed out after 10s, forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  try {
    await srv.close();
    await pool.end();
    console.log('shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('error during shutdown:', err);
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
