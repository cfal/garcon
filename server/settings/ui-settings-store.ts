import {
  GENERATION_UI_SETTING_KEYS,
  generationSelectionNodeError,
  parseNodeProjectPreferences,
  parseNodeProjectPreferencesPatch,
} from '../../common/settings.js';
import {
  bumpRemoteSettingsVersion,
  normalizeRemoteSettingsVersion,
  normalizeUiSettings,
} from './settings-shared.js';
import {
  normalizePathSettings,
  sanitizeExecutionDefaultsSettings,
} from './startup-recents.js';
import type { ProjectSettings, SettingsStoreContext } from './types.js';
import { ValidationDomainError } from '../lib/domain-error.js';

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
      const error = generationSelectionNodeError(patch[key]);
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
    const nodePatches = patch.byNode === undefined ? undefined : parseNodeProjectPreferencesPatch(patch.byNode);
    if (nodePatches === null) throw new Error('Invalid execution-node project preferences');
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      const next = { ...(settings.paths || {}), ...patch };
      if (nodePatches) {
        const byNode = { ...parseNodeProjectPreferences(settings.paths.byNode) };
        for (const [nodeId, fields] of Object.entries(nodePatches)) {
          byNode[nodeId] = { ...(byNode[nodeId] ?? { recentPaths: [], pinnedPaths: [] }), ...fields };
        }
        next.byNode = byNode;
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
