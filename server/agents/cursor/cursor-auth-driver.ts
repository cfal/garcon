import type { AgentAuthDriver } from '../types.js';
import { getCursorAuthStatus } from './cursor-auth.js';

export const cursorAuthDriver: AgentAuthDriver = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
