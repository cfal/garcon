import type { AgentAuthDriver } from '../types.js';
import { getCursorAuthStatus } from '../../providers/cursor-auth.js';

export const cursorAuthDriver: AgentAuthDriver = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
