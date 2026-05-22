import type { HarnessAuthDriver } from '../../harness-plugin.js';
import { getCursorAuthStatus } from '../../cursor-auth.js';

export const cursorAuthDriver: HarnessAuthDriver = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
