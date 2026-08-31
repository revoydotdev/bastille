import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Repo } from './repo.js';
import { Poller } from './jobs/poller.js';
import { SnapshotJob } from './jobs/snapshot.js';
import { registerRoutes } from './routes.js';
import { ClearanceRepo } from './clearance/repo.js';
import { ClearanceSweepJob } from './jobs/clearance-sweep.js';
import { registerClearanceRoutes } from './clearance/routes.js';

// Resolve paths against the repo, not the shell's cwd — `npm start
// --workspace=server` runs from server/, `node dist/index.js` from anywhere.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true });

  const db = openDb(process.env.BASTILLE_DB ?? resolve(REPO_ROOT, 'data/bastille.db'));
  const repo = new Repo(db);
  const poller = new Poller(repo);
  const snapshotJob = new SnapshotJob(repo);
  const clearanceRepo = new ClearanceRepo(db);
  const clearanceSweep = new ClearanceSweepJob(clearanceRepo);

  registerRoutes(app, repo, poller, snapshotJob);
  registerClearanceRoutes(app, clearanceRepo, clearanceSweep);

  // Serve the built dashboard when it exists, so `npm start` is the whole app.
  const webDist = resolve(REPO_ROOT, 'web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  poller.start();
  snapshotJob.start();
  clearanceSweep.start();

  let shuttingDown = false;
  const shutdown = async () => {
    // A second signal means "I meant it" - stop waiting and go.
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    poller.stop();
    snapshotJob.stop();
    clearanceSweep.stop();
    // Backstop: never let a stuck connection hold the process open.
    const failsafe = setTimeout(() => process.exit(1), 5_000);
    failsafe.unref();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
