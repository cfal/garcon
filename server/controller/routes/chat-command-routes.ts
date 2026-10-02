import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  parseAgentHandoffCommandRequest,
  parseAgentInterruptAndSendCommandRequest,
  parseAgentRunCommandRequest,
  parseAgentStopCommandRequest,
  parseCompactCommandRequest,
  parseForkChatCommandRequest,
  parseForkRunCommandRequest,
  parseQueueEntrySteerCommandRequest,
  parseSteerCommandRequest
} from '../../../common/chat-command-contracts.js';
import type {
  CommandAcceptedResponse,
  ExecutionSettingsPatchRequest,
  ModelPatchRequest,
  QueueCommandErrorResponse,
  QueueEntrySteerErrorResponse,
  RunningChatsResponse,
} from '../../../common/chat-command-contracts.ts';
import {
  parsePermissionDecisionCommandRequest,
  parseProjectPathPatchRequest,
  parseQueueEntryCreateCommandRequest,
  parseQueueEntryDeleteCommandRequest,
  parseQueueEntryMoveCommandRequest,
  parseQueueEntryReplaceCommandRequest,
  parseQueueMutationRequest,
  parseQueueResumeRequest,
  parseStartChatCommandRequest,
} from '../../../common/chat-command-contracts.ts';
import {
  normalizePermissionMode,
  normalizeThinkingMode,
} from '../../../common/chat-modes.js';
import type { ParentChatRef } from '../../../common/chat-parentage.js';
import { AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS } from '../../../common/handoff-timeouts.js';
import type { JsonObject } from '../../../common/json.js';
import { parseSelfHandoffRunCommandRequest } from '../../../common/self-handoff-contracts.js';
import { DomainError } from '../../common/domain-error.js';
import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { AgentSessionSettingsPatch } from '../agents/session-types.js';
import { ModelSelectionError } from '../api-providers/endpoint-resolver.js';
import { AttachmentValidationError, validateCommandAttachments } from '../attachments/validation.js';
import {
  QueueEntryMutationError,
  QueuePauseChangedError,
  type ChatExecutionService,
} from '../chat-execution/chat-execution-coordinator.js';
import {
  toClientChatExecutionControlState,
} from '../chat-execution/control-state.ts';
import { QueueEntrySteerError } from '../chat-execution/queue-steer-error.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ChatCommandService } from '../commands/chat-command-service.js';
import {
  CommandExecutionControlError,
} from '../commands/chat-command-service.js';
import { commandHttpError, parseCommandRequest } from '../lib/command-http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import { requireStringField } from './route-helpers.js';

// Bun interprets zero as an unlimited idle window for provider-native forks.
const FORK_REQUEST_TIMEOUT_SECONDS = 0;

interface RequestTimeoutServer {
  timeout(request: Request, seconds: number): void;
}

function isRequestTimeoutServer(value: unknown): value is RequestTimeoutServer {
  return value !== null
    && typeof value === 'object'
    && typeof (value as { timeout?: unknown }).timeout === 'function';
}

function acceptedTurnResponse(
  result: CommandAcceptedResponse,
  parentChat: ParentChatRef | null,
): Response {
  if (!result.chatId || !result.turnId) {
    throw new Error('Accepted agent turn is missing its receipt identity');
  }
  const location = `/api/v1/chats/turn-receipt?chatId=${encodeURIComponent(result.chatId)}&turnId=${encodeURIComponent(result.turnId)}`;
  return Response.json(
    { ...result, parentChat },
    { status: 202, headers: { Location: location } },
  );
}

function validatedCommandAttachments(value: unknown) {
  try {
    return validateCommandAttachments(value);
  } catch (error) {
    if (error instanceof AttachmentValidationError) {
      throw new DomainError('VALIDATION_FAILED', error.message, error.status);
    }
    throw error;
  }
}

function optionalStringOrNull(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' ? value : null;
}

function chatSettingsPatchErrorResponse(error: unknown): Response {
  if (error instanceof ModelSelectionError) {
    return jsonError(error.message, 422, 'MODEL_SELECTION_ERROR');
  }
  if (error instanceof AgentIntegrationError && error.code === 'INVALID_SETTINGS') {
    return jsonError(error.message, 422, error.code, error.retryable);
  }
  return jsonErrorFromUnknown(error);
}

export function createChatCommandRoutes({ commands, registry, agents, queue }: {
  commands: ChatCommandService;
  registry: Pick<IChatRegistry, 'getChat' | 'hasChat'>;
  agents: Pick<AgentRegistryServiceContract, 'getRunningSessions' | 'updateSessionSettings'>;
  queue: Pick<ChatExecutionService, 'readChatExecutionControl'>;
}): RouteMap {


  async function postStartSession(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseStartChatCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitStart({ ...input, images });
      return acceptedTurnResponse(result, registry.getChat(input.chatId)?.parentChat ?? null);
    } catch (error: unknown) {
      if (error instanceof ModelSelectionError) {
        return jsonError((error as Error).message, 422);
      }
      return commandHttpError(error);
    }
  }

  async function postForkChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseForkChatCommandRequest, body);
      if (isRequestTimeoutServer(server)) server.timeout(request, FORK_REQUEST_TIMEOUT_SECONDS);
      const result = await commands.forkChat(input, request.signal);

      return Response.json(result);
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postRunChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentRunCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      if (input.handoff && isRequestTimeoutServer(server)) {
        server.timeout(request, AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS);
      }
      const result = await commands.submitRun({ ...input, images });

      return acceptedTurnResponse(result, registry.getChat(input.chatId)?.parentChat ?? null);
    } catch (error: unknown) {
      return handoffOrRunErrorResponse(error);
    }
  }

  async function postAgentHandoff(body: unknown, request: Request, _url: URL, server?: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentHandoffCommandRequest, body);
      if (isRequestTimeoutServer(server)) server.timeout(request, AGENT_HANDOFF_REQUEST_TIMEOUT_SECONDS);
      return Response.json(await commands.submitAgentHandoff(input, request.signal));
    } catch (error) {
      return handoffOrRunErrorResponse(error);
    }
  }

  function handoffOrRunErrorResponse(error: unknown): Response {
    if (error instanceof CommandExecutionControlError) {
      const body: QueueCommandErrorResponse = {
        success: false, error: error.message, errorCode: error.code, retryable: error.retryable,
        control: toClientChatExecutionControlState(error.control),
      };
      return Response.json(body, { status: error.status });
    }
    return commandHttpError(error);
  }

  async function postForkRunChat(
    body: unknown,
    request: Request,
    _url: URL,
    server?: unknown,
  ): Promise<Response> {
    try {
      const input = parseCommandRequest(parseForkRunCommandRequest, body);
      if (isRequestTimeoutServer(server)) server.timeout(request, FORK_REQUEST_TIMEOUT_SECONDS);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitForkRun({ ...input, images });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postSelfHandoffRunChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseSelfHandoffRunCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitSelfHandoffRun({ ...input, images });

      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function getRunningChats(): Promise<Response> {
    const response: RunningChatsResponse = {
      sessions: agents.getRunningSessions(),
    };
    return Response.json(response);
  }

  async function getQueue(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) return jsonError('chatId query parameter is required', 400);
    if (!registry.hasChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
    const control = toClientChatExecutionControlState(await queue.readChatExecutionControl(chatId));
    return Response.json({ success: true, chatId, control });
  }

  function queueControlErrorResponse(error: unknown): Response {
    if (!(error instanceof QueueEntryMutationError) && !(error instanceof QueuePauseChangedError)) {
      return commandHttpError(error);
    }
    const body: QueueCommandErrorResponse = {
      success: false,
      error: error.message,
      errorCode: error.code,
      retryable: error.retryable,
      control: toClientChatExecutionControlState(error.control),
    };
    return Response.json(body, { status: error.status });
  }

  async function postQueueEntryCreate(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryCreateCommandRequest, body);
      const images = validatedCommandAttachments(input.images);
      const result = await commands.submitQueueEntryCreate({
        ...input,
        ...(images === undefined ? {} : { images }),
      });
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      return queueControlErrorResponse(error);
    }
  }

  async function putQueueEntry(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryReplaceCommandRequest, body);
      const result = await commands.submitQueueEntryReplace(input);
      return Response.json(result);
    } catch (error: unknown) {
      return queueControlErrorResponse(error);
    }
  }

  async function deleteQueueEntry(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryDeleteCommandRequest, body);
      const result = await commands.submitQueueEntryDelete(input);
      return Response.json(result);
    } catch (error: unknown) {
      return queueControlErrorResponse(error);
    }
  }

  async function putQueueEntryMove(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseQueueEntryMoveCommandRequest, body);
      const result = await commands.submitQueueEntryMove(input);
      return Response.json(result);
    } catch (error: unknown) {
      return queueControlErrorResponse(error);
    }
  }

  async function postSteer(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseSteerCommandRequest, body);
      const result = await commands.submitSteer(input);
      return Response.json({
        ...result,
        parentChat: registry.getChat(input.chatId)?.parentChat ?? null,
      }, { status: 202 });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postQueueEntrySteer(body: unknown): Promise<Response> {
    let chatId: string | null = null;
    try {
      const input = parseCommandRequest(parseQueueEntrySteerCommandRequest, body);
      chatId = input.chatId;
      const result = await commands.submitQueueEntrySteer(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      if (error instanceof QueueEntrySteerError && chatId) {
        const control = error.control
          ? toClientChatExecutionControlState(error.control)
          : undefined;
        const serverInstanceId = control?.serverInstanceId
          ?? (await queue.readChatExecutionControl(chatId)).serverInstanceId;
        const response: QueueEntrySteerErrorResponse = {
          success: false,
          error: error.message,
          errorCode: error.code,
          retryable: error.retryable,
          deliveryOutcome: error.deliveryOutcome,
          serverInstanceId,
          ...(control ? { control } : {}),
        };
        return Response.json(response, { status: error.status });
      }
      return commandHttpError(error);
    }
  }

  async function postQueueMutation(body: unknown, action: 'clear' | 'pause' | 'resume'): Promise<Response> {
    try {
      const input = action === 'resume'
        ? parseCommandRequest(parseQueueResumeRequest, body)
        : parseCommandRequest(parseQueueMutationRequest, body);
      const result = await commands.mutateQueue({ ...input, action });
      return Response.json(result);
    } catch (error: unknown) {
      return queueControlErrorResponse(error);
    }
  }

  async function postPermissionDecision(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parsePermissionDecisionCommandRequest, body);
      const result = await commands.submitPermissionDecision(input);
      return Response.json(result);
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postStopChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentStopCommandRequest, body);
      const result = await commands.submitStop(input);
      return Response.json({
        ...result,
        parentChat: registry.getChat(input.chatId)?.parentChat ?? null,
      });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postInterruptAndSend(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseAgentInterruptAndSendCommandRequest, body);
      const result = await commands.submitInterruptAndSend(input);
      return Response.json(result);
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function postCompactChat(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseCompactCommandRequest, body);
      const result = await commands.submitCompact(input);
      return Response.json(result, { status: 202 });
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }

  async function patchExecutionSettings(
    body: ExecutionSettingsPatchRequest & Record<string, unknown>,
    request: Request,
  ): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const expectedEpoch = body.expectedAgentOwnershipEpoch === undefined
        ? undefined : requireStringField(body, 'expectedAgentOwnershipEpoch');
      const chat = registry.getChat(chatId);
      if (!chat) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      const patch: AgentSessionSettingsPatch = {};
      if (body.permissionMode !== undefined) {
        patch.permissionMode = normalizePermissionMode(body.permissionMode);
      }
      if (body.thinkingMode !== undefined) {
        patch.thinkingMode = normalizeThinkingMode(body.thinkingMode);
      }
      if (body.agentSettingsPatch !== undefined) {
        if (!body.agentSettingsPatch || typeof body.agentSettingsPatch !== 'object' || Array.isArray(body.agentSettingsPatch)) {
          return jsonError('agentSettingsPatch must be an object', 400, 'VALIDATION_FAILED');
        }
        patch.agentSettingsPatch = body.agentSettingsPatch as JsonObject;
      }
      const hasPatch = Object.keys(patch).length > 0;
      const updated = hasPatch
        ? await agents.updateSessionSettings(chatId, patch, expectedEpoch, request.signal)
        : chat;
      return Response.json({
        success: true,
        chatId,
        permissionMode: updated.permissionMode,
        thinkingMode: updated.thinkingMode,
        agentSettings: updated.agentSettingsById?.[updated.agentId] ?? chat.agentSettingsById[chat.agentId],
      });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchModel(body: ModelPatchRequest & Record<string, unknown>, request: Request): Promise<Response> {
    try {
      const chatId = requireStringField(body, 'chatId');
      const expectedEpoch = body.expectedAgentOwnershipEpoch === undefined
        ? undefined : requireStringField(body, 'expectedAgentOwnershipEpoch');
      const model = requireStringField(body, 'model');
      if (!registry.hasChat(chatId)) return jsonError('Session not found', 404, 'SESSION_NOT_FOUND');
      const apiProviderId = optionalStringOrNull(body.apiProviderId);
      const modelEndpointId = optionalStringOrNull(body.modelEndpointId);
      const modelProtocol = optionalStringOrNull(body.modelProtocol);
      const patch: AgentSessionSettingsPatch = { model };
      if (apiProviderId !== undefined) patch.apiProviderId = apiProviderId;
      if (modelEndpointId !== undefined) patch.modelEndpointId = modelEndpointId;
      if (modelProtocol !== undefined)
        patch.modelProtocol = modelProtocol as AgentSessionSettingsPatch['modelProtocol'];
      await agents.updateSessionSettings(chatId, patch, expectedEpoch, request.signal);
      return Response.json({ success: true, chatId, ...patch });
    } catch (error: unknown) {
      return chatSettingsPatchErrorResponse(error);
    }
  }

  async function patchProjectPath(body: unknown): Promise<Response> {
    try {
      const input = parseCommandRequest(parseProjectPathPatchRequest, body);
      const result = await commands.updateProjectPath(input);
      return Response.json(result);
    } catch (error: unknown) {
      return commandHttpError(error);
    }
  }
  return {
    '/api/v1/chats/start': { POST: withJsonBody(postStartSession) },
    '/api/v1/chats/run': { POST: withJsonBody(postRunChat) },
    '/api/v1/chats/fork': { POST: withJsonBody(postForkChat) },
    '/api/v1/chats/fork-run': { POST: withJsonBody(postForkRunChat) },
    '/api/v1/chats/handoff-run': { POST: withJsonBody(postSelfHandoffRunChat) },
    '/api/v1/chats/compact': { POST: withJsonBody(postCompactChat) },
    '/api/v1/chats/running': { GET: getRunningChats },
    '/api/v1/chats/queue': { GET: getQueue },
    '/api/v1/chats/queue/entries': {
      POST: withJsonBody(postQueueEntryCreate),
      PUT: withJsonBody(putQueueEntry),
      DELETE: withJsonBody(deleteQueueEntry),
    },
    '/api/v1/chats/queue/entries/move': {
      PUT: withJsonBody(putQueueEntryMove),
    },
    '/api/v1/chats/steer': { POST: withJsonBody(postSteer) },
    '/api/v1/chats/queue/entries/steer': { POST: withJsonBody(postQueueEntrySteer) },
    '/api/v1/chats/queue/clear': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'clear')),
    },
    '/api/v1/chats/queue/pause': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'pause')),
    },
    '/api/v1/chats/queue/resume': {
      POST: withJsonBody((body: unknown) => postQueueMutation(body, 'resume')),
    },
    '/api/v1/chats/permissions/decision': {
      POST: withJsonBody(postPermissionDecision),
    },
    '/api/v1/chats/stop': { POST: withJsonBody(postStopChat) },
    '/api/v1/chats/interrupt-and-send': { POST: withJsonBody(postInterruptAndSend) },
    '/api/v1/chats/execution-settings': {
      PATCH: withJsonBody(patchExecutionSettings),
    },
    '/api/v1/chats/agent-handoff': { POST: withJsonBody(postAgentHandoff) },
    '/api/v1/chats/model': { PATCH: withJsonBody(patchModel) },
    '/api/v1/chats/project-path': { PATCH: withJsonBody(patchProjectPath) }
  };
}
