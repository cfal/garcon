import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '@garcon/common/json';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { AgentIntegrationError, type AgentSessionConfigurationUpdates } from '@garcon/server-agent-interface';
import { SessionConfigurationPreparations } from '@garcon/server-agent-common/execution/session-configuration';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createArtificialNativePath } from '@garcon/server-agent-common/chats/artificial-native-path';
import { mapPermissionMode } from './permissions.js';
import { createOpenCodeRequestScope, throwOpenCodeResultError, withOpenCodeRequestScope, type OpenCodeRequestScope } from './sdk-result.js';
import type { OpenCodeSession } from './turn-events.js';
import type { OpenCodeOperationRoutes } from './operation-routes.js';
import { assertOpenCodeExecutionOpen, type OpenCodeResumeRequest } from './runtime-types.js';
import { OpenCodeTimeoutError } from './request-control.js';

type PermissionRule = ReturnType<typeof mapPermissionMode>[number];

interface PermissionClient {
  session: {
    get(request: { sessionID: string; directory?: string }, options: { signal: AbortSignal }): Promise<unknown>;
    update(request: { sessionID: string; directory?: string; permission: PermissionRule[] }, options: { signal: AbortSignal }): Promise<unknown>;
  };
}

export interface PreparedConfigurationTurn {
  readonly session: OpenCodeSession | undefined;
  validate(): void;
  release(): void;
}

export function prepareOpenCodeConfigurationTurn(
  request: Omit<OpenCodeResumeRequest, 'command' | 'images'>,
  currentSession: () => OpenCodeSession | undefined,
): PreparedConfigurationTurn {
  assertOpenCodeExecutionOpen(request);
  const session = currentSession();
  const directory = createOpenCodeRequestScope(request.projectPath).directory;
  if (session && (session.chatId !== request.chatId || session.directory !== directory)) {
    throw new AgentIntegrationError('OPERATION_UNSUPPORTED', 'OpenCode session identity or admission changed', false);
  }
  if (session?.configurationPreparing) {
    throw new AgentIntegrationError('SESSION_BUSY', 'OpenCode session is already preparing a turn', true);
  }
  const epoch = session ? ++session.configurationEpoch : null;
  if (session) session.configurationPreparing = true;
  return {
    session,
    validate: () => {
      assertOpenCodeExecutionOpen(request);
      if (currentSession() !== session || (session && (session.configurationEpoch !== epoch || !session.configurationPreparing))) {
        throw new Error('OpenCode session changed during turn admission');
      }
    },
    release: () => {
      if (session?.configurationEpoch === epoch) session.configurationPreparing = false;
    },
  };
}

export async function reconcileOpenCodeTurnPermissions(input: {
  client: PermissionClient;
  request: Omit<OpenCodeResumeRequest, 'command' | 'images'>;
  scope: OpenCodeRequestScope;
  timeoutMs: number;
  validate(): void;
  run(signal: AbortSignal, operation: () => Promise<void>): Promise<void>;
}): Promise<void> {
  const { request, timeoutMs } = input;
  const deadline = new AbortController();
  const timeout = setTimeout(() => deadline.abort(new OpenCodeTimeoutError('OpenCode session permissions', timeoutMs)), timeoutMs);
  const signal = request.executionAdmission ? AbortSignal.any([request.executionAdmission.signal, deadline.signal]) : deadline.signal;
  try {
    await input.run(signal, () => reconcileOpenCodePermissions({ client: input.client, sessionId: request.agentSessionId,
      scope: input.scope, mode: request.permissionMode, signal, validate: input.validate }));
  } finally { clearTimeout(timeout); }
}

export function createOpenCodeSessionConfiguration(options: {
  session(id: string): OpenCodeSession | undefined;
  generation(): number;
  shuttingDown(): boolean;
  routes: OpenCodeOperationRoutes;
}): AgentSessionConfigurationUpdates {
  const codec = createPathNativeSessionCodec('opencode');
  return new SessionConfigurationPreparations(({ expected, next }) => {
    let native: ReturnType<typeof codec.decode>;
    try { native = codec.decode(expected.nativeSession); }
    catch { return { kind: 'rejected', reason: 'target-conflict' }; }
    if ((native.agentSessionId !== null && native.agentSessionId !== expected.agentSessionId)
      || (native.path !== null && native.path !== createArtificialNativePath('opencode', expected.agentSessionId))
      || native.modelEndpointId !== null) return { kind: 'rejected', reason: 'target-conflict' };
    const session = options.session(expected.agentSessionId);
    if (!session) return null;
    const directory = createOpenCodeRequestScope(expected.projectPath).directory;
    if (session.chatId !== expected.chatId || session.directory !== directory
      || session.configurationPreparing || session.aborting || options.shuttingDown()) {
      return { kind: 'rejected', reason: 'target-conflict' };
    }
    if (session.permissionMode === 'bypassPermissions' && next.permissionMode !== 'bypassPermissions') {
      throw cannotRestoreOpenCodePermissions();
    }
    const epoch = ++session.configurationEpoch;
    const generation = options.generation();
    const turn = session.turn;
    const status = session.status;
    const permissionMode = session.permissionMode;
    const route = options.routes.forTurn(turn);
    return {
      validate: () => options.session(expected.agentSessionId) === session
        && options.generation() === generation && !options.shuttingDown()
        && session.configurationEpoch === epoch && !session.configurationPreparing && !session.aborting
        && session.turn === turn && session.status === status && session.permissionMode === permissionMode
        && session.chatId === expected.chatId && session.directory === directory
        && (route === null || options.routes.isRegistered(route)),
      async deliver(beforeMutation) {
        // Native rules are snapshotted for a busy loop. Only this equivalent native policy
        // can change live through Garcon's permission route; other settings reassert on resume.
        if (status !== 'running' || !route || permissionMode === next.permissionMode
          || !isManualPolicy(permissionMode) || !isManualPolicy(next.permissionMode)) return 'not-required';
        beforeMutation();
        if (!options.routes.updatePermissionMode(route, next.permissionMode)) {
          throw new Error('OpenCode configuration route retired before delivery');
        }
        session.permissionMode = next.permissionMode;
        return 'applied';
      },
    };
  });
}

function isManualPolicy(mode: PermissionMode): boolean {
  return mode === 'default' || mode === 'manualBypass';
}

export function cannotRestoreOpenCodePermissions(): AgentIntegrationError {
  return new AgentIntegrationError('OPERATION_UNSUPPORTED',
    'OpenCode cannot restore session permissions after bypass mode. Start a fresh session with the desired permission mode.', false);
}

export async function reconcileOpenCodePermissions(input: {
  client: PermissionClient;
  sessionId: string;
  scope: OpenCodeRequestScope;
  mode: PermissionMode;
  signal: AbortSignal;
  validate(): void;
}): Promise<void> {
  const { client, sessionId, scope, mode, signal, validate } = input;
  const check = () => { signal.throwIfAborted(); validate(); };
  const parameters = withOpenCodeRequestScope({ sessionID: sessionId }, scope);
  check();
  const current = nativeRules(await client.session.get(parameters, { signal }), sessionId, scope);
  check();
  const desired = mapPermissionMode(mode);
  const bypass = mapPermissionMode('bypassPermissions');
  // The pinned update handler appends rules; leaving bypass cannot restore inherited policy.
  // https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L194-L199
  if (mode !== 'bypassPermissions' && current.some((_, index) => isDeepStrictEqual(current.slice(index, index + bypass.length), bypass))) {
    throw cannotRestoreOpenCodePermissions();
  }
  if (isDeepStrictEqual(current.slice(-desired.length), desired)) return;
  check();
  const updated = nativeRules(await client.session.update({ ...parameters, permission: desired }, { signal }), sessionId, scope);
  check();
  if (!isDeepStrictEqual(updated, [...current, ...desired])) {
    throw new Error('OpenCode did not confirm the requested session permissions');
  }
}

function nativeRules(result: unknown, sessionId: string, scope: OpenCodeRequestScope): PermissionRule[] {
  throwOpenCodeResultError(result, 'OpenCode session permissions are unavailable');
  const info = isRecord(result) && isRecord(result.data) ? result.data : null;
  if (!info || info.id !== sessionId || info.directory !== scope.directory
    || (info.permission !== undefined && !Array.isArray(info.permission))) {
    throw new Error('OpenCode returned conflicting native session permissions');
  }
  return (info.permission ?? []).map(rule => {
    if (!isRecord(rule) || typeof rule.permission !== 'string' || typeof rule.pattern !== 'string'
      || (rule.action !== 'ask' && rule.action !== 'allow' && rule.action !== 'deny')) {
      throw new Error('OpenCode returned invalid session permissions');
    }
    return { permission: rule.permission, pattern: rule.pattern, action: rule.action };
  });
}
