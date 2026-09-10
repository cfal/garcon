import type { Logger } from '../lib/log.js';

const CARRY_OVER_MIGRATION_LOG_INTERVAL_MS = 10_000;

export async function runCarryOverMigrationAtStartup(
  migrate: () => Promise<void>,
  progressLogger: Pick<Logger, 'info'>,
): Promise<void> {
  const startedAt = Date.now();
  const elapsedSeconds = () => Math.floor((Date.now() - startedAt) / 1_000);

  progressLogger.info(
    'Workspace history migration started. This one-time upgrade may take several minutes.',
  );
  const heartbeat = setInterval(() => {
    progressLogger.info(
      `Workspace history migration is still running (${elapsedSeconds()}s elapsed).`,
    );
  }, CARRY_OVER_MIGRATION_LOG_INTERVAL_MS);

  try {
    await migrate();
  } finally {
    clearInterval(heartbeat);
  }
  progressLogger.info(
    `Workspace history migration completed (${elapsedSeconds()}s elapsed).`,
  );
}
