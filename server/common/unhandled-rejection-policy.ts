import { errorMessage } from './errors.js';
import type { Logger } from './log.js';

// One failed detached task must not terminate unrelated agent processes or PTYs.
export function installUnhandledRejectionPolicy(logger: Pick<Logger, 'error'>): () => void {
  const report = (error: unknown) => {
    logger.error('unhandled rejection (non-fatal):', errorMessage(error));
  };
  process.on('unhandledRejection', report);
  return () => { process.off('unhandledRejection', report); };
}
