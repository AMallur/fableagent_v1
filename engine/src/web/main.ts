// Entry point: DATABASE_URL=postgres://... node src/web/main.ts [--port 8787]
import { startServer } from './server.ts';

const { default: pg } = await import('pg');
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://localhost:5432/rcm_dev',
});

const portArg = process.argv.indexOf('--port');
const { port } = await startServer(pool, {
  port: portArg > -1 ? Number(process.argv[portArg + 1]) : undefined,
});
console.log(`RCM Recovery interface listening on http://localhost:${port}`);
