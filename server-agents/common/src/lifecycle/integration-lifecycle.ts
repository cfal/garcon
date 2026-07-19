import type {
  AgentLifecycle,
  AgentMigrationStore,
} from '@garcon/server-agent-interface';

export interface IntegrationLifecycleOptions {
  readonly start?: () => void | Promise<void>;
  readonly stop?: () => void | Promise<void>;
  readonly migrateOwnedStorage?: (
    store: AgentMigrationStore,
  ) => void | Promise<void>;
}

export function createIntegrationLifecycle(
  options: IntegrationLifecycleOptions,
): AgentLifecycle {
  let active = false;
  let startAttempted = false;

  return {
    async start() {
      if (active || startAttempted) return;
      startAttempted = true;
      try {
        await options.start?.();
        active = true;
      } catch (error) {
        try {
          await options.stop?.();
        } finally {
          startAttempted = false;
          active = false;
        }
        throw error;
      }
    },
    async stop() {
      if (!active && !startAttempted) return;
      active = false;
      startAttempted = false;
      await options.stop?.();
    },
    async migrateOwnedStorage(store) {
      await options.migrateOwnedStorage?.(store);
    },
  };
}
