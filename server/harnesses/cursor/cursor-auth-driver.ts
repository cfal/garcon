import type { HarnessAuthDriver } from '../types.js';
import { getCursorAuthStatus } from '../../providers/cursor-auth.js';

export const cursorAuthDriver: HarnessAuthDriver = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
