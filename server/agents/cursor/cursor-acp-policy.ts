import { getCursorBinary } from '../../config.js';
import type { PermissionMode, ResumeTurnRequest, StartSessionRequest } from '../session-types.js';
import type { AcpAgentPolicy } from '../shared/acp-agent-runtime.js';

export function mapCursorAcpPermissionMode(permissionMode: PermissionMode): string {
  return permissionMode === 'plan' ? 'plan' : 'agent';
}

export function mapCursorAcpModel(model: string): string | undefined {
  if (!model || model === 'default') return 'default[]';
  if (model === 'auto') return 'default[]';
  return model;
}

export function buildCursorAcpPrompt(request: StartSessionRequest | ResumeTurnRequest): Array<{ type: string; text: string }> {
  if (request.images?.length) {
    throw new Error('Cursor ACP does not currently support image attachments in Garcon.');
  }
  return [{ type: 'text', text: request.command.trim() }];
}

export function buildCursorAcpEnv(request: StartSessionRequest | ResumeTurnRequest): Record<string, string | undefined> {
  return { ...process.env, ...request.envOverrides };
}

export function createCursorAcpPolicy(): AcpAgentPolicy {
  return {
    agentId: 'cursor',
    command: getCursorBinary(),
    args: ['acp'],
    authenticateMethodId: 'cursor_login',
    buildPrompt: buildCursorAcpPrompt,
    buildEnv: buildCursorAcpEnv,
    mapPermissionMode: mapCursorAcpPermissionMode,
    mapModel: mapCursorAcpModel,
  };
}
