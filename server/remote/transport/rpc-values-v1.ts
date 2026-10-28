import { isAgentResourceRef } from '@garcon/server-agent-interface';
import { isRecord } from '@garcon/common/json';
import { parseAgentSettingsEnvelope } from '@garcon/common/agent-integration';
import { isPermissionMode, isThinkingMode } from '@garcon/common/chat-modes';
import { parseCliIdentity } from '@garcon/common/server-runtime';
import { parseProjectResolution } from '@garcon/common/project-resolution';
import { parseTicketProjectDefault } from '@garcon/common/ticket-responses';
import { parseNativeSeedReceipt } from '@garcon/common/transcript-seed';
import { parseUserMessagePresentation } from '@garcon/common/chat-types';
import { isGitMethod, isGhMethod, validateGitRequest, validateGhRequest } from '../../../common/git-request-validation.js';
import { validateGitResult, validateGhResult } from '../../../common/git-result-validation.js';
import { GIT_OPERATION_TIMEOUT_MS, ghOperationTimeoutMs, isGitMutation } from '../../../common/git-execution.js';
import { isGhMutation } from '../../../common/gh.js';
import { GitServiceError } from '../../../common/git-error.js';
import { parseTerminalListResponse, parseTerminalCreateResponse, parseTerminalRenameResponse, parseTerminalTerminateResponse } from '../../../common/terminal.js';
import { validateFileRpcRequest, parseFileRpcResultV1 } from './file-protocol.js';
import type { FileRpcMethods } from './file-protocol.js';
import { validateTerminalRpc, type TerminalRpcRequest } from './terminal-protocol.js';
import { parseControllerCliEnvelope, parseCliHttpResponse } from './cli-protocol.js';
import { decodeRenderedMessageV1, decodeEstablishedSessionV1, isNativeSessionV1 as native, isJsonObject } from './producer-protocol.js';
import { validateManifest } from './executor-inventory.js';
import type { ExecutorRpcMethods, IntegrationManifest } from './rpc-protocol.js';

type Method = keyof ExecutorRpcMethods;
const text = (value: unknown): value is string => typeof value === 'string';
const nonempty = (value: unknown): value is string => text(value) && value.length > 0;
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const bool = (value: unknown) => typeof value === 'boolean';
const nullableText = (value: unknown) => value === null || text(value);
const fields = (value: unknown, names: readonly string[]) => isRecord(value) && names.every(name => text(value[name]));
const booleanFields = (value: unknown, names: readonly string[]) => isRecord(value) && names.every(name => bool(value[name]));
const positiveInteger = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const protocol = (value: unknown) => value === 'anthropic-messages' || value === 'openai-compatible';
const optionalText = (value: unknown) => value === undefined || text(value);
const optionalBoolean = (value: unknown) => value === undefined || bool(value);
const nativeOrNull = (value: unknown) => value === null || native(value);

function requireValue(valid: unknown): asserts valid {
  if (!valid) throw new SyntaxError('Invalid RPC v1 data');
}

function configuration(value: unknown): boolean {
  return isRecord(value) && text(value.model) && isPermissionMode(value.permissionMode) && isThinkingMode(value.thinkingMode)
    && parseAgentSettingsEnvelope(value.settings) !== null && (value.endpoint === null || endpoint(value.endpoint));
}

function credential(value: unknown): boolean {
  return isRecord(value) && value.kind === 'api-provider-endpoint' && nonempty(value.apiProviderId)
    && nonempty(value.endpointId) && positiveInteger(value.revision);
}

function endpoint(value: unknown): boolean {
  return isRecord(value) && fields(value, ['apiProviderId', 'endpointId', 'providerLabel', 'baseUrl', 'model'])
    && protocol(value.protocol) && bool(value.isLocal)
    && (value.capabilities === null || isRecord(value.capabilities) && bool(value.capabilities.chatCompletions) && bool(value.capabilities.responses))
    && isRecord(value.headers) && Object.values(value.headers).every(text)
    && (value.credential === null || credential(value.credential));
}

function chatReference(value: unknown): boolean {
  if (!isRecord(value) || !fields(value, ['chatId', 'agentId', 'projectPath', 'model', 'carryOverRevision'])
    || !nullableText(value.agentSessionId) || !nativeOrNull(value.nativeSession) || !parseAgentSettingsEnvelope(value.settings)) return false;
  const receipt = value.nativeSeedReceipt === null ? null : parseNativeSeedReceipt(value.nativeSeedReceipt);
  return value.nativeSeedReceipt === null || receipt !== null && receipt.agentSessionId === value.agentSessionId;
}

function legacyScope(value: unknown): boolean {
  return isRecord(value) && text(value.recordId) && (value.kind === 'execution-defaults' ? nullableText(value.selectedAgentId)
    : ['chat', 'scheduled-prompt', 'recent-agent-setting', 'handoff'].includes(value.kind as string) && text(value.selectedAgentId));
}

function model(value: unknown): boolean {
  return isRecord(value) && fields(value, ['value', 'label']) && optionalBoolean(value.supportsImages) && optionalBoolean(value.isLocal)
    && ['apiProviderId', 'endpointId', 'rawModel'].every(key => optionalText(value[key]))
    && (value.protocol === undefined || protocol(value.protocol));
}

function deviceAuth(value: unknown): boolean {
  return value === undefined || isRecord(value) && text(value.url) && optionalText(value.code) && optionalBoolean(value.needsCode);
}

function launch(value: Record<string, unknown>, start: boolean): void {
  requireValue(configuration(value) && fields(value, ['chatId', 'projectPath', 'runId', 'prompt'])
    && isAgentResourceRef(value.producerBinding, 'producer') && Array.isArray(value.attachments)
    && value.attachments.every(item => isRecord(item) && item.kind === 'image' && text(item.data)
      && nullableText(item.name) && text(item.mimeType)));
  if (start) requireValue(value.carriedContext === null || isRecord(value.carriedContext)
    && text(value.carriedContext.prefix) && optionalBoolean(value.carriedContext.summaryTruncated));
  else requireValue(nonempty(value.agentSessionId) && nativeOrNull(value.nativeSession));
  if (value.submission !== undefined) {
    requireValue(isRecord(value.submission) && nullableText(value.submission.clientMessageId) && text(value.submission.timestamp));
    parseUserMessagePresentation(value.submission.presentation);
  }
}

export function parseRpcRequestV1(method: Method, value: unknown): unknown {
  if (method.startsWith('files.')) { validateFileRpcRequest(method, value); return value; }
  if (method.startsWith('terminals.')) {
    validateTerminalRpc({ method, version: 1, request: value } as TerminalRpcRequest);
    return value;
  }
  if (method.startsWith('git.') || method.startsWith('gh.')) {
    if (!isRecord(value) || !isRecord(value.input) || !positiveInteger(value.budgetMs)) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid Git RPC request');
    const name = method.slice(method.indexOf('.') + 1);
    if (method.startsWith('git.') && isGitMethod(name)) {
      if ((value.budgetMs as number) > GIT_OPERATION_TIMEOUT_MS) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid Git RPC deadline');
      validateGitRequest(name, value.input);
    } else if (isGhMethod(name)) {
      if ((value.budgetMs as number) > ghOperationTimeoutMs(name)) throw new GitServiceError('GIT_INVALID_INPUT', 'Invalid GitHub RPC deadline');
      validateGhRequest(name, value.input);
    } else throw new SyntaxError('Unknown RPC v1 method');
    return value;
  }
  switch (method) {
    case 'executor.describe': case 'controllerCli.describe': case 'execution.runningSessions':
    case 'lifecycle.start': case 'lifecycle.stop': case 'lifecycle.migrateOwnedStorage':
    case 'auth.status': case 'auth.launchLogin': case 'readiness.status': requireValue(value === null); break;
    case 'controllerCli.request': return parseControllerCliEnvelope(value);
    case 'execution.abort': requireValue(isAgentResourceRef(value, 'execution')); break;
    case 'producers.close': requireValue(isAgentResourceRef(value, 'producer')); break;
    case 'history.close': requireValue(isAgentResourceRef(value, 'history-reader')); break;
    case 'projectPathUpdates.commit': case 'projectPathUpdates.rollback': requireValue(isAgentResourceRef(value, 'project-path-preparation')); break;
    case 'settings.migrate': requireValue(parseAgentSettingsEnvelope(value)); break;
    case 'configurationValidation.validate': requireValue(configuration(value)); break;
    default: {
      requireValue(isRecord(value));
      switch (method) {
        case 'execution.start': case 'execution.resume': case 'compaction.compact':
          launch(value, method === 'execution.start');
          break;
        case 'producers.bind': requireValue(isAgentResourceRef(value.binding, 'producer') && nonempty(value.chatId)); break;
        case 'producers.cancelLaunch': requireValue(isAgentResourceRef(value.binding, 'producer') && text(value.runId)); break;
        case 'producers.resume': requireValue(Array.isArray(value.bindings) && value.bindings.every(item => isRecord(item)
          && isAgentResourceRef(item.binding, 'producer') && Number.isSafeInteger(item.acknowledgedSeq) && (item.acknowledgedSeq as number) >= 0)); break;
        case 'history.open': requireValue(['legacyHistoryImport', 'nativeHistoryImport'].includes(value.source as string)
          && isRecord(value.request) && chatReference(value.request.chat)); break;
        case 'history.next': requireValue(isAgentResourceRef(value.reader, 'history-reader') && Number.isSafeInteger(value.page) && (value.page as number) >= 0); break;
        case 'calls.reconcile': requireValue(Array.isArray(value.calls) && value.calls.every(item => fields(item, ['id', 'session'])
          && isRecord(item) && positiveInteger(item.seq)) && new Set(value.calls.map(item => item.id)).size === value.calls.length); break;
        case 'catalog.snapshot': requireValue(bool(value.strict)); break;
        case 'credentials.resolve': requireValue(credential(value.reference)); break;
        case 'projects.inspect': requireValue(text(value.projectPath) && optionalBoolean(value.includeGitRepository)); break;
        case 'projects.ticketProjectDefault': case 'commands.discover': requireValue(text(value.projectPath)); break;
        case 'projects.resolveFileMentions': requireValue(fields(value, ['projectPath', 'command'])); break;
        case 'apiProviders.discoverModels': requireValue(protocol(value.protocol) && text(value.baseUrl) && optionalText(value.apiKey)
          && ['none', 'anthropic-models', 'openai-models', 'ollama-tags', 'openrouter-models'].includes(value.modelDiscovery as string)); break;
        case 'auth.completeLogin': requireValue(fields(value, ['sessionId', 'code'])); break;
        case 'auth.loginStatus': requireValue(value.expectedSessionId === undefined || text(value.expectedSessionId)); break;
        case 'migration.translateLegacyModel': requireValue(legacyScope(value.scope) && isRecord(value.scope) && value.scope.kind !== 'execution-defaults' && text(value.model)); break;
        case 'migration.translateLegacyNativeSession': requireValue(fields(value, ['chatId', 'projectPath', 'model'])
          && nullableText(value.agentSessionId) && nullableText(value.legacyNativePath) && isJsonObject(value.legacyValues)); break;
        case 'migration.translateLegacySettings': requireValue(legacyScope(value.scope) && isJsonObject(value.legacyValues)); break;
        case 'permissions.respond': requireValue(isAgentResourceRef(value.response, 'permission-response') && isRecord(value.decision)
          && bool(value.decision.allow) && optionalBoolean(value.decision.alwaysAllow)
          && (value.decision.response === undefined || isJsonObject(value.decision.response))); break;
        case 'forking.fork': requireValue(configuration(value) && fields(value, ['chatId', 'projectPath']) && chatReference(value.source)
          && (value.providerMeta === null || isJsonObject(value.providerMeta))); break;
        case 'forking.discard': decodeEstablishedSessionV1(value); break;
        case 'steering.captureTarget': requireValue(fields(value, ['chatId', 'agentSessionId', 'expectedRunId'])
          && nativeOrNull(value.nativeSession) && isAgentResourceRef(value.producerBinding, 'producer')); break;
        case 'steering.steer': requireValue(fields(value, ['chatId', 'projectPath', 'agentSessionId', 'input', 'clientMessageId'])
          && nativeOrNull(value.nativeSession) && (value.target === null || isAgentResourceRef(value.target, 'steer-target'))); break;
        case 'singleQuery.run': requireValue(fields(value, ['prompt', 'model']) && isThinkingMode(value.thinkingMode)
          && parseAgentSettingsEnvelope(value.settings) && (value.endpoint === null || endpoint(value.endpoint))
          && (value.timeoutMs === undefined || positiveInteger(value.timeoutMs))); break;
        case 'nativeSessions.resolveNativeSession': case 'nativeSessions.describeSource': requireValue(chatReference(value.chat)); break;
        case 'nativeSessions.release': requireValue(chatReference(value.chat) && ['deleted', 'transferred'].includes(value.reason as string)); break;
        case 'nativeActivity.lastActivity': requireValue(native(value)); break;
        case 'projectPathUpdates.prepare': requireValue(chatReference(value.chat) && text(value.nextProjectPath)); break;
        case 'sessionConfiguration.apply': requireValue(Array.isArray(value.args) && value.args.length === 3 && text(value.args[0]) && configuration(value.args[1]) && configuration(value.args[2])); break;
        case 'endpoints.validate': requireValue(endpoint(value)); break;
        default: throw new SyntaxError('Unknown RPC v1 method');
      }
    }
  }
  return value;
}

export function parseRpcResultV1(method: Method, value: unknown): unknown {
  if (method.startsWith('files.')) return parseFileRpcResultV1(method as keyof FileRpcMethods, value);
  if (method.startsWith('git.') || method.startsWith('gh.')) {
    const name = method.slice(method.indexOf('.') + 1);
    const git = method.startsWith('git.') && isGitMethod(name) ? name : null;
    const gh = method.startsWith('gh.') && isGhMethod(name) ? name : null;
    try {
      if (!isRecord(value) || !fields(value, ['executorId', 'instanceId'])) throw new GitServiceError('GIT_INVALID_RESULT', 'Invalid Git result scope');
      const scope = { executorId: value.executorId as string, instanceId: value.instanceId as string };
      if (git) validateGitResult(git, value, scope);
      else if (gh) validateGhResult(gh, value, scope);
      else throw new SyntaxError('Unknown RPC v1 method');
    } catch (error) {
      if (git && isGitMutation(git) || gh && isGhMutation(gh)) throw new GitServiceError('GIT_MUTATION_OUTCOME_UNKNOWN', 'Git mutation could not be confirmed. Inspect the repository before trying again.');
      throw error;
    }
    return value;
  }
  switch (method) {
    case 'terminals.list': requireValue(parseTerminalListResponse(value)); break;
    case 'terminals.create': requireValue(parseTerminalCreateResponse(value)); break;
    case 'terminals.rename': requireValue(parseTerminalRenameResponse(value)); break;
    case 'terminals.terminate': requireValue(parseTerminalTerminateResponse(value)); break;
    case 'controllerCli.describe': requireValue(parseCliIdentity(value)); break;
    case 'controllerCli.request': return parseCliHttpResponse(value);
    case 'execution.start': case 'execution.resume': case 'compaction.compact': requireValue(isAgentResourceRef(value, 'execution')); break;
    case 'history.open': requireValue(isAgentResourceRef(value, 'history-reader')); break;
    case 'steering.captureTarget': requireValue(value === null || isAgentResourceRef(value, 'steer-target')); break;
    case 'execution.abort': requireValue(bool(value)); break;
    case 'settings.migrate': requireValue(parseAgentSettingsEnvelope(value)); break;
    case 'migration.translateLegacySettings': requireValue(value === null || parseAgentSettingsEnvelope(value)); break;
    case 'migration.translateLegacyNativeSession': case 'nativeSessions.resolveNativeSession': requireValue(value === null || native(value)); break;
    case 'projects.resolveFileMentions': case 'singleQuery.run': case 'migration.translateLegacyModel': requireValue(text(value)); break;
    case 'terminals.attach': case 'terminals.detach': case 'terminals.input': case 'terminals.resize':
    case 'producers.bind': case 'producers.close': case 'producers.cancelLaunch': case 'permissions.respond':
    case 'lifecycle.start': case 'lifecycle.stop': case 'lifecycle.migrateOwnedStorage':
    case 'forking.discard': case 'endpoints.validate': case 'history.close': case 'nativeSessions.release':
    case 'configurationValidation.validate': case 'sessionConfiguration.apply':
    case 'projectPathUpdates.commit': case 'projectPathUpdates.rollback': requireValue(value === undefined || value === null); break;
    case 'execution.runningSessions': requireValue(Array.isArray(value) && value.every(item => isRecord(item) && nonempty(item.agentSessionId)
      && nullableText(item.status) && nullableText(item.startedAt)) && new Set(value.map(item => item.agentSessionId)).size === value.length); break;
    case 'commands.discover': requireValue(Array.isArray(value) && value.every(item => isRecord(item) && text(item.name)
      && ['command', 'skill'].includes(item.source as string) && optionalText(item.description))); break;
    case 'credentials.resolve': requireValue(value === null || fields(value, ['kind', 'value'])); break;
    case 'projectPathUpdates.prepare': requireValue(value === null || isRecord(value) && isAgentResourceRef(value.preparation, 'project-path-preparation')
      && (value.nativeSession === undefined || nativeOrNull(value.nativeSession))); break;
    case 'nativeSessions.describeSource': requireValue(value === null || isRecord(value)
      && ['filesystem-path', 'provider-reference'].includes(value.kind as string) && text(value.value)); break;
    default: {
      requireValue(isRecord(value));
      switch (method) {
        case 'executor.describe': requireValue(isRecord(value.info) && fields(value.info, ['executorId', 'instanceId', 'projectBasePath'])
          && texts(value.info.integrationIds) && new Set(value.info.integrationIds).size === value.info.integrationIds.length
          && booleanFields(value.info.services, ['files', 'git', 'gh', 'terminals', 'directoryCreation'])
          && Array.isArray(value.integrations));
          for (const manifest of value.integrations) validateManifest(manifest as IntegrationManifest);
          break;
        case 'calls.reconcile': requireValue(Array.isArray(value.states) && value.states.every(item => isRecord(item) && text(item.id) && ['pending', 'not-received', 'unknown'].includes(item.state as string))); break;
        case 'producers.resume': requireValue(Array.isArray(value.resumed)); break;
        case 'catalog.snapshot': requireValue(Array.isArray(value.models) && value.models.every(model) && text(value.defaultModel) && bool(value.requiresStrictModelDiscovery)
          && (value.generation === null || isRecord(value.generation) && text(value.generation.model) && Number.isFinite(value.generation.priority))); break;
        case 'readiness.status': requireValue(bool(value.ready) && text(value.reason)); break;
        case 'history.next': requireValue(bool(value.done) && Array.isArray(value.rows));
          for (const row of value.rows as unknown[]) {
            requireValue(isRecord(row) && (row.providerMeta === undefined || isJsonObject(row.providerMeta)));
            decodeRenderedMessageV1(row.message);
          }
          break;
        case 'forking.fork': requireValue(value.kind === 'unmaterialized' || value.kind === 'materialized');
          if (value.kind === 'materialized') decodeEstablishedSessionV1(value.session);
          break;
        case 'steering.steer': requireValue(value.kind === 'accepted' || value.kind === 'rejected'
          && ['no-active-turn', 'turn-changed', 'turn-not-steerable', 'invalid-input', 'provider-rejected'].includes(value.reason as string) && text(value.message)
          || value.kind === 'failed' && ['unknown', 'not-sent'].includes(value.outcome as string) && text(value.message)); break;
        case 'nativeActivity.lastActivity': requireValue(value.kind === 'unavailable' || value.kind === 'ready' && isRecord(value.value) && nullableText(value.value.lastEntryAt)); break;
        case 'projects.inspect': requireValue(parseProjectResolution(value.resolution) && optionalBoolean(value.isGitRepository)); break;
        case 'projects.ticketProjectDefault': parseTicketProjectDefault(value); break;
        case 'apiProviders.discoverModels': requireValue(bool(value.success) && (value.models === undefined || Array.isArray(value.models)
          && value.models.every(model)) && optionalText(value.error)); break;
        case 'auth.status': requireValue(bool(value.authenticated) && bool(value.canReauth) && text(value.label)
          && ['oauth', 'api-key', 'environment', 'cli', 'none', 'unknown'].includes(value.source as string) && optionalText(value.detail)); break;
        case 'auth.launchLogin': requireValue(bool(value.launched) && bool(value.alreadyRunning) && text(value.sessionId) && deviceAuth(value.deviceAuth)); break;
        case 'auth.completeLogin': requireValue(value.submitted === true && text(value.sessionId)); break;
        case 'auth.loginStatus': requireValue(bool(value.running) && (value.state === 'idle' && value.running === false
          || ['running', 'succeeded', 'failed'].includes(value.state as string) && text(value.sessionId)));
          if (value.state === 'running') requireValue(value.running === true && bool(value.completionPending)
            && optionalText(value.retryableError) && deviceAuth(value.deviceAuth));
          else requireValue(value.running === false);
          if (value.state === 'failed') requireValue(text(value.error));
          break;
        default: throw new SyntaxError('Unknown RPC v1 method');
      }
    }
  }
  return value;
}
