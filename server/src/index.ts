import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.js';
import { Repo } from './repo.js';
import { Poller } from './jobs/poller.js';
import { registerRoutes } from './routes.js';

const PORT = Number(process.env.PORT ?? 5175);
const HOST = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  await app.register(cors, { origin: true });

  const db = openDb();
  const repo = new Repo(db);
  const poller = new Poller(repo);

  registerRoutes(app, repo, poller);

  // Serve the built dashboard when it exists, so `npm start` is the whole app.
  const webDist = resolve('web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  poller.start();

  const shutdown = async () => {
    poller.stop();
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
