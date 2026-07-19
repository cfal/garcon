import type { AgentAuth } from '@garcon/server-agent-common/legacy/types';
import { getCursorAuthStatus } from './cursor-auth.js';

export const cursorAuthDriver: AgentAuth = {
  async getAuthStatus() {
    return getCursorAuthStatus();
  },
};
