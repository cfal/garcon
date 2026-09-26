import { isPermissionMode, isThinkingMode, type PermissionMode, type ThinkingMode } from './chat-modes.js';
import { parseAgentSettingsEnvelope, type AgentSettingsEnvelope } from './agent-integration.js';
import type { ApiProtocol } from './api-providers.js';
import type { AgentHandoffCommandRequest, AgentHandoffRequest } from './chat-command-contracts.js';
import { parseExecutorId } from './executors.js';
import {
  CommandRequestValidationError,
  optionalNullableString,
  optionalString,
  requestRecord,
  requiredChatId,
  requiredCommandCorrelationId,
  requiredString,
} from './command-request-validation.js';

export function parseAgentHandoffCommandRequest(value: unknown): AgentHandoffCommandRequest {
  const body = requestRecord(value);
  const handoff = optionalAgentHandoffRequest(body.handoff);
  if (!handoff) throw new CommandRequestValidationError('handoff is required');
  return {
    chatId: requiredChatId(body, 'chatId'),
    clientRequestId: requiredCommandCorrelationId(body, 'clientRequestId'),
    handoff,
  };
}

export function optionalAgentHandoffRequest(value: unknown): AgentHandoffRequest | undefined {
  if (value === undefined) return undefined;
  const handoff = requestRecord(value);
  const target = requestRecord(handoff.target);
  const executorId = parseExecutorId(target.executorId);
  if (!executorId) throw new CommandRequestValidationError('handoff.target.executorId is invalid');
  const projectPath = optionalString(target, 'projectPath');
  const agentId = requiredString(target, 'agentId');
  const model = requiredString(target, 'model');
  const apiProviderId = optionalNullableString(target, 'apiProviderId');
  const modelEndpointId = optionalNullableString(target, 'modelEndpointId');
  const modelProtocol = optionalApiProtocol(target.modelProtocol);
  if (modelEndpointId !== undefined && modelEndpointId !== null && apiProviderId == null) {
    throw new CommandRequestValidationError(
      'handoff.target.apiProviderId is required with modelEndpointId',
    );
  }
  const permissionMode = optionalPermissionMode(target.permissionMode);
  const thinkingMode = optionalThinkingMode(target.thinkingMode);
  const agentSettings = optionalAgentSettings(target.agentSettings, 'handoff.target.agentSettings');
  if (agentSettings && agentSettings.ownerId !== agentId) {
    throw new CommandRequestValidationError(
      'handoff.target.agentSettings must be owned by handoff.target.agentId',
    );
  }
  return {
    target: {
      ...(target.executorId === undefined ? {} : { executorId }),
      ...(projectPath === undefined ? {} : { projectPath }),
      agentId,
      model,
      ...(apiProviderId === undefined ? {} : { apiProviderId }),
      ...(modelEndpointId === undefined ? {} : { modelEndpointId }),
      ...(modelProtocol === undefined ? {} : { modelProtocol }),
      ...(permissionMode === undefined ? {} : { permissionMode }),
      ...(thinkingMode === undefined ? {} : { thinkingMode }),
      ...(agentSettings === undefined ? {} : { agentSettings }),
    },
    expectedAgentOwnershipEpoch: requiredString(
      handoff,
      'expectedAgentOwnershipEpoch',
    ),
  };
}

export function optionalPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPermissionMode(value)) {
    throw new CommandRequestValidationError('permissionMode is invalid');
  }
  return value;
}

export function optionalThinkingMode(value: unknown): ThinkingMode | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isThinkingMode(value)) {
    throw new CommandRequestValidationError('thinkingMode is invalid');
  }
  return value;
}

export function optionalApiProtocol(value: unknown): ApiProtocol | null | undefined {
  if (value === undefined || value === null) return value;
  if (value === 'anthropic-messages' || value === 'openai-compatible') return value;
  throw new CommandRequestValidationError('modelProtocol is invalid');
}

export function requiredAgentSettings(value: unknown, field: string): AgentSettingsEnvelope {
  const parsed = parseAgentSettingsEnvelope(value);
  if (!parsed) throw new CommandRequestValidationError(`${field} is invalid`);
  return parsed;
}

export function optionalAgentSettings(value: unknown, field: string): AgentSettingsEnvelope | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredAgentSettings(value, field);
}
