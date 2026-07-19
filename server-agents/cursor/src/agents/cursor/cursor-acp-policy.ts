import { getCursorBinary } from '../../config.js';
import type { PermissionMode, ResumeTurnRequest, StartSessionRequest } from '@garcon/server-agent-common/legacy/session-types';
import type { AcpAgentPolicy } from '../shared/acp-agent-runtime.js';
import { configureCursorAcpSession, cursorAcpModeForPermissionMode } from './cursor-acp-model-config.js';
import { createCursorAcpNativePath } from './cursor-native-path.js';

function mappedMode(permissionMode: PermissionMode): string {
  return cursorAcpModeForPermissionMode(permissionMode);
}

function promptForRequest(request: StartSessionRequest | ResumeTurnRequest): Array<{ type: string; text: string }> {
  if (request.images?.length) {
    throw new Error('Cursor ACP does not currently support image attachments in Garcon.');
  }
  return [{ type: 'text', text: request.command.trim() }];
}

function buildEnv(request: StartSessionRequest | ResumeTurnRequest): Record<string, string | undefined> {
  return { ...process.env, ...request.envOverrides };
}

export function createCursorAcpPolicy(): AcpAgentPolicy {
  return {
    agentId: 'cursor',
    command: getCursorBinary(),
    args: ['acp'],
    abortStrategy: 'process-restart',
    authenticateMethodId: 'cursor_login',
    clientCapabilities: {
      _meta: {
        // Enables Cursor's split model/context/reasoning config options.
        // See https://github.com/zed-industries/zed/issues/57571 and
        // https://forum.cursor.com/t/bug-agent-acp-model-switching-updates-session-metadata-but-does-not-change-the-inference-backend/157312.
        parameterizedModelPicker: true,
      },
    },
    newSessionModelConfig: false,
    promptModelConfig: false,
    promptModeConfig: false,
    configureSession: configureCursorAcpSession,
    buildPrompt: promptForRequest,
    buildEnv,
    mapPermissionMode: mappedMode,
    resolveNativePath: createCursorAcpNativePath,
  };
}
