import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import type { SettingsStore } from '../settings/store.js';
import type { WorkflowRuntime } from './setup.js';

export class WorkflowSettings {
  readonly #lock = new KeyedPromiseLock();
  constructor(private readonly settings: Pick<SettingsStore, 'confirmDurability' | 'setFeatureSettings' | 'getFeatureSettings'>,
    private readonly runtime: WorkflowRuntime) {}

  setEnabled(enabled: boolean, assertCurrent: () => void): Promise<void> {
    return this.#lock.runExclusive('workflow-setting', async () => {
      await this.settings.confirmDurability();
      assertCurrent();
      if (!enabled) {
        await this.runtime.disable();
        assertCurrent();
        await this.settings.setFeatureSettings({ workflows: { enabled: false } });
        return;
      }
      await this.settings.setFeatureSettings({ workflows: { enabled: true } });
      try { assertCurrent(); await this.runtime.enable(); }
      catch (error) {
        await this.runtime.disable().catch(() => {});
        await this.settings.setFeatureSettings({ workflows: { enabled: false } });
        throw error;
      }
    });
  }
}
