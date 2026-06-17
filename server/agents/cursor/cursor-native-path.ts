import { createArtificialNativePath, getArtificialAgentSessionId } from '../../chats/artificial-native-path.js';

export const CURSOR_AGENT_ID = 'cursor';
export const CURSOR_ACP_NATIVE_AGENT_ID = 'cursor-acp';
export const CURSOR_STREAM_JSON_NATIVE_AGENT_ID = 'cursor-stream-json';

export const CURSOR_NATIVE_AGENT_IDS = [
  CURSOR_STREAM_JSON_NATIVE_AGENT_ID,
  CURSOR_ACP_NATIVE_AGENT_ID,
  CURSOR_AGENT_ID,
] as const;

export function createCursorStreamJsonNativePath(agentSessionId: string | null | undefined): string | null {
  return createArtificialNativePath(CURSOR_STREAM_JSON_NATIVE_AGENT_ID, agentSessionId);
}

export function getCursorAcpAgentSessionIdFromNativePath(nativePath: unknown): string | null {
  return getArtificialAgentSessionId(nativePath, CURSOR_ACP_NATIVE_AGENT_ID);
}

export function getCursorAgentSessionIdFromNativePath(nativePath: unknown): string | null {
  return getArtificialAgentSessionId(nativePath, CURSOR_NATIVE_AGENT_IDS);
}
