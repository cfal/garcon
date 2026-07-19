import type { PermissionMode } from '@garcon/common/chat-modes';
import type { AgentLogger } from '@garcon/server-agent-interface';
import type { CursorConfig } from '../../config.js';
import type { AcpAgentPolicy } from '../shared/acp-agent-runtime.js';
import type { AcpResumeRequest, AcpStartRequest } from '../shared/runtime-types.js';
import { configureCursorAcpSession, cursorAcpModeForPermissionMode } from './cursor-acp-model-config.js';
import { createCursorAcpNativePath } from './cursor-native-path.js';

function mappedMode(permissionMode: PermissionMode): string {
  return cursorAcpModeForPermissionMode(permissionMode);
}

function promptForRequest(request: AcpStartRequest | AcpResumeRequest): Array<{ type: string; text: string }> {
  if (request.images?.length) {
    throw new Error('Cursor ACP does not currently support image attachments in Garcon.');
  }
  return [{ type: 'text', text: request.command.trim() }];
}

export function createCursorAcpPolicy(config: CursorConfig, logger?: AgentLogger): AcpAgentPolicy {
  return {
    agentId: 'cursor',
    command: config.binary,
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
    configureSession: (context) => configureCursorAcpSession(context, logger),
    buildPrompt: promptForRequest,
    buildEnv(request) {
      const apiKey = config.apiKey();
      return {
        ...process.env,
        ...(apiKey ? { CURSOR_API_KEY: apiKey } : {}),
        ...request.envOverrides,
      };
    },
    mapPermissionMode: mappedMode,
    resolveNativePath: createCursorAcpNativePath,
  };
}
