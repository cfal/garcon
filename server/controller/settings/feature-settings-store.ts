import {
  DEFAULT_REMOTE_FEATURE_SETTINGS,
  normalizeRemoteFeatureSettings,
} from '../../../common/settings.js';
import { bumpRemoteSettingsVersion } from './settings-shared.js';
import type {
  ProjectSettings,
  SettingsStoreContext
} from './types.js';


export class FeatureSettingsStore {
  #context: SettingsStoreContext;

  constructor(context: SettingsStoreContext) {
    this.#context = context;
  }

  getFeatureSettings(): ProjectSettings['features'] {
    const features = normalizeRemoteFeatureSettings(
      this.#context.readSettings().features ?? DEFAULT_REMOTE_FEATURE_SETTINGS,
    );
    return structuredClone(features);
  }

  async setFeatureSettings(
    patch: Partial<ProjectSettings['features']>,
  ): Promise<ProjectSettings['features']> {
    return this.#context.mutate(async () => {
      const settings = this.#context.readSettings();
      settings.features = {
        ...normalizeRemoteFeatureSettings(settings.features),
        ...patch,
      };
      bumpRemoteSettingsVersion(settings);
      await this.#context.saveAndMaybeEmitRemote(settings, true);
      return structuredClone(settings.features);
    });
  }
}
