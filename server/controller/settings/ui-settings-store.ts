import {
  GENERATION_UI_SETTING_KEYS,
  generationSelectionExecutorError,
  parseExecutorProjectPreferencesPatch,
} from '../../../common/settings.js';
import {
  bumpRemoteSettingsVersion,
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
} from './settings-shared.js';
import {
  normalizePathSettings,
  readExecutorProjectPreferences,
  sanitizeExecutionDefaultsSettings,
} from './startup-recents.js';
import type { ProjectSettings, SettingsStoreContext } from './types.js';
import { ValidationDomainError } from '../../common/domain-error.js';
import { reconcileProjectPins } from '../../../common/project-pins.js';
import { isRecord } from '../../../common/json.js';

export class UiSettingsStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getUiSettings(): ProjectSettings['ui'] {
    const settings = this.#context.readSettings();
    return normalizeUiSettings(settings.ui || {});
  }

  async setUiSettings(patch: Record<string, unknown>): Promise<ProjectSettings['ui']> {
    for (const key of GENERATION_UI_SETTING_KEYS) {
      const error = generationSelectionExecutorError(patch[key]);
      if (error) throw new ValidationDomainError(error);
    }
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.ui = normalizeUiSettings({ ...(settings.ui || {}), ...patch });
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.ui;
    });
  }

  getPathSettings(): ProjectSettings['paths'] {
    const settings = this.#context.readSettings();
    return settings.paths || {};
  }

  async setPathSettings(patch: Record<string, unknown>): Promise<ProjectSettings['paths']> {
    const executorPatches = patch.byExecutor === undefined ? undefined : parseExecutorProjectPreferencesPatch(patch.byExecutor);
    if (executorPatches === null) throw new Error('Invalid executor project preferences');
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const next = { ...(settings.paths || {}), ...patch };
      if (Array.isArray(patch.pinnedProjectPaths)) {
        const pins = reconcileProjectPins(settings.paths.pinnedProjectPaths, patch.pinnedProjectPaths, next.recentProjectPaths);
        next.pinnedProjectPaths = pins.pinnedPaths;
        next.recentProjectPaths = pins.recentPaths;
      }
      if (executorPatches) {
        if (settings.paths.byExecutor !== undefined && !isRecord(settings.paths.byExecutor)) {
          throw new Error('Invalid executor project preferences');
        }
        const byExecutor = { ...(isRecord(settings.paths.byExecutor) ? settings.paths.byExecutor : {}) };
        const validPreferences = readExecutorProjectPreferences(byExecutor);
        for (const [executorId, fields] of Object.entries(executorPatches)) {
          if (executorId in byExecutor && !validPreferences[executorId]) throw new Error('Invalid executor project preferences');
          const previous = validPreferences[executorId] ?? { recentPaths: [], pinnedPaths: [] };
          byExecutor[executorId] = { ...previous, ...fields, ...(fields.pinnedPaths === undefined ? {} :
            reconcileProjectPins(previous.pinnedPaths, fields.pinnedPaths, previous.recentPaths)) };
        }
        next.byExecutor = byExecutor;
      }
      settings.paths = normalizePathSettings(next);
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return settings.paths;
    });
  }

  getRemoteSettingsVersion(): number {
    const settings = this.#context.readSettings();
    return normalizeRemoteSettingsVersion(settings.remoteSettingsVersion);
  }

  getRemoteSettingsSnapshotSource(): {
    version: number;
    ui: ProjectSettings['ui'];
    paths: ProjectSettings['paths'];
    pinnedChatIds: string[];
    recentAgentSettings: ProjectSettings['recentAgentSettings'];
    executionDefaults: ProjectSettings['executionDefaults'];
  } {
    const settings = this.#context.readSettings();
    const executionDefaults = sanitizeExecutionDefaultsSettings(settings.executionDefaults).defaults;
    return {
      version: normalizeRemoteSettingsVersion(settings.remoteSettingsVersion),
      ui: normalizeUiSettings(settings.ui || {}),
      paths: settings.paths || {},
      pinnedChatIds: settings.pinnedChatIds || [],
      recentAgentSettings: settings.recentAgentSettings || [],
      executionDefaults,
    };
  }
}
