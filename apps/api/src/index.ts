// Side-effect import — must come first so .env populates process.env before
// any module reads it.
import './lib/load-env.js';

import { loadConfig } from './config.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp({ config });

  const close = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    app.log.error({ err }, 'failed to start server');
    process.exit(1);
  }
}

void main();
