import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { connectDatabase, disconnectDatabase } from './db/index.js';

async function main() {
  const { driver, uri } = await connectDatabase();
  console.log(`[db] connected via "${driver}" driver${uri ? ` → ${uri}` : ''}`);
  if (driver === 'memory') {
    console.log('[db] in-memory driver: schemas are enforced, data is not persisted across restarts');
  }

  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.port, () => {
    console.log(`[http] TriageHandler backend listening on :${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`\n[http] ${signal} received, shutting down`);
    server.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[fatal] failed to start backend:', error);
  process.exit(1);
});
