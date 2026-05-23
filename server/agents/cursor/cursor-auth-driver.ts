import type { AgentAuth } from '../types.js';
import { getCursorAuthStatus } from './cursor-auth.js';

export const cursorAuthDriver: AgentAuth = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
