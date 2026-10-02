import { isRecord } from '../../../common/json.js';
import { createLogger } from '../../common/log.js';
import { bumpRemoteSettingsVersion } from './settings-shared.js';
import {
  dedupeRecentAgentSettings,
  recordRecentProjectPath,
  sanitizeExecutionDefaults,
  sanitizeExecutionDefaultsSettings,
  sanitizeRecentAgentSetting,
  withoutExecutorStartupPreferences,
} from './startup-recents.js';
import type {
  ChatStartupPreferences,
  ExecutionDefaults,
  ProjectSettings,
  SettingsStoreContext,
} from './types.js';

const logger = createLogger('settings:startup-defaults');

export class StartupDefaultsStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getRecentAgentSettings(): ProjectSettings['recentAgentSettings'] {
    const settings = this.#context.readSettings();
    return settings.recentAgentSettings || [];
  }

  async forgetExecutor(executorId: string): Promise<void> {
    await this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      Object.assign(settings, withoutExecutorStartupPreferences(settings, executorId));
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
    });
  }

  getRecentProjectPaths(): string[] {
    const settings = this.#context.readSettings();
    const paths = settings.paths || {};
    return Array.isArray(paths.recentProjectPaths)
      ? paths.recentProjectPaths.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  getExecutionDefaults(): ProjectSettings['executionDefaults'] {
    const settings = this.#context.readSettings();
    return sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
  }

  // Startup preferences are advisory: recording happens after a chat already
  // dispatched, so a persistence failure is logged instead of failing the chat.
  async recordChatStartup(defaults: ChatStartupPreferences | null | undefined): Promise<void> {
    try {
      await this.#context.mutate(async () => {
        const settings = this.#context.readSettings();

        const recent = sanitizeRecentAgentSetting(defaults);
        if (recent) {
          settings.recentAgentSettings = dedupeRecentAgentSettings([
            recent,
            ...(settings.recentAgentSettings || []),
          ]);
        }

        settings.paths = recordRecentProjectPath(settings.paths || {}, defaults?.projectPath, defaults?.executorId);

        const agentId = typeof defaults?.agentId === 'string' ? defaults.agentId.trim() : recent?.agentId ?? '';
        if (agentId) {
          const current = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
          // Chat starts carry a single agentSettings envelope for the starting
          // agent rather than a prebuilt agentSettingsById map.
          const envelope = isRecord(defaults?.agentSettings) ? defaults.agentSettings : null;
          settings.executionDefaults = {
            ...current,
            byAgent: {
              ...current.byAgent,
              [agentId]: sanitizeExecutionDefaults({
                permissionMode: defaults?.permissionMode,
                thinkingMode: defaults?.thinkingMode,
                agentSettingsById: defaults?.agentSettingsById
                  ?? (envelope ? { [agentId]: envelope } : undefined),
              }),
            },
          };
        }

        bumpRemoteSettingsVersion(settings);
        await this.#context.saveAndMaybeEmitRemote(settings, true);
      });
    } catch (error: unknown) {
      logger.warn(
        'settings: failed to record chat startup preferences:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async updateExecutionDefaultsForAgent(
    agentId: string,
    patch: Partial<ExecutionDefaults>,
  ): Promise<void> {
    const trimmedAgentId = agentId.trim();
    if (!trimmedAgentId) return;

    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const current = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
      const merged = sanitizeExecutionDefaults({
        ...current.global,
        ...(current.byAgent[trimmedAgentId] ?? {}),
        ...patch,
      });

      settings.executionDefaults = {
        ...current,
        byAgent: {
          ...current.byAgent,
          [trimmedAgentId]: merged,
        },
      };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
    });
  }
}
