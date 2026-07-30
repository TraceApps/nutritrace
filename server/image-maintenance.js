import { logger } from './logger.js';
import { runImageMaintenance } from './lib/image-maintenance.js';

const LOOP_BASE_MS = 24 * 60 * 60 * 1000;
const LOOP_JITTER_MS = 60 * 60 * 1000;

function nextDelay() {
  return LOOP_BASE_MS + Math.round((Math.random() * 2 - 1) * LOOP_JITTER_MS);
}

async function wait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const loop = process.argv.includes('--loop');
  if (!loop) {
    await runImageMaintenance({ vacuum: true });
    return;
  }

  // The primary container always performs a foreground startup run. Delay the
  // sidecar's first run so both containers do not immediately VACUUM the same
  // database. Each later run receives independent ±1 hour jitter.
  while (true) {
    const delay = nextDelay();
    logger.info(`[image-maintenance] next background run in ${Math.round(delay / 60000)} minutes`);
    await wait(delay);
    try {
      await runImageMaintenance({ vacuum: true });
    } catch (err) {
      logger.error(`[image-maintenance] background run failed: ${err.stack || err.message}`);
    }
  }
}

main().catch(err => {
  logger.error(`[image-maintenance] fatal: ${err.stack || err.message}`);
  process.exit(1);
});
