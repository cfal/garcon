import crypto from 'node:crypto';
import type { PermissionDecisionPayload } from '@garcon/common/chat-command-contracts';
import { errorMessage } from '@garcon/server-agent-common/lib/errors';
import type { AgentRuntimeOperation } from '@garcon/server-agent-common/execution/runtime-events';
import type {
  OpenCodeOperationEventSource,
  OpenCodeOperationRoute,
} from './operation-routes.js';
import {
  OpenCodeQuestionController,
  type OpenCodeQuestionControllerOptions,
} from './questions.js';
import { convertOpencodePermissionTool } from './permission-tool-converter.js';
import {
  isOpenCodeNotFoundResult,
  throwOpenCodeResultError,
  withOpenCodeRequestScope,
} from './sdk-result.js';
import type { SSEEvent } from './sse-events.js';

// Source of OpenCode permission keys:
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/web/src/content/docs/permissions.mdx
// - https://github.com/anomalyco/opencode/blob/f5eade1d2b95562c7fb58e3041e662a8b2b611b6/packages/opencode/src/agent/agent.ts
export const OPENCODE_PERMISSION_KEYS = Object.freeze([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const);

const OPENCODE_NATIVE_PLAN_PERMISSIONS = new Set(['plan_enter', 'plan_exit']);

export function mapPermissionMode(mode: string): Array<{ permission: string; pattern: string; action: string }> {
  // Native plan transitions create unmarked synthetic continuations that cannot be safely
  // affiliated with an operation, so bypass mode keeps them unavailable.
  const map: Record<string, Record<string, string>> = {
    acceptEdits: { edit: 'allow', bash: 'ask', webfetch: 'allow' },
    bypassPermissions: Object.fromEntries(OPENCODE_PERMISSION_KEYS.map((permission) => [
      permission,
      OPENCODE_NATIVE_PLAN_PERMISSIONS.has(permission) ? 'deny' : 'allow',
    ])),
    manualBypass: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
    default: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  };

  const selected = map[mode] || map.default;
  return Object.entries(selected).map(([permission, action]) => ({
    permission,
    pattern: '*',
    action,
  }));
}

export function mapPermissionDecision(
  decision: { allow?: boolean; alwaysAllow?: boolean } | null | undefined,
): string {
  const allow = Boolean(decision?.allow);
  const alwaysAllow = Boolean(decision?.alwaysAllow);
  return allow ? (alwaysAllow ? 'always' : 'once') : 'reject';
}

export function extractPermissionRequest(event: SSEEvent): {
  requestId: string;
  toolInput: Record<string, unknown>;
} | null {
  if (event.type !== 'permission.asked') return null;

  const props = event.properties || {};
  const requestId = props.requestID || props.id;
  if (!requestId) return null;

  return {
    requestId: String(requestId),
    toolInput: {
      permission: props.permission || null,
      patterns: Array.isArray(props.patterns) ? props.patterns : [],
      metadata: props.metadata || {},
      always: Array.isArray(props.always) ? props.always : [],
      tool: props.tool || null,
    },
  };
}

interface PendingOpenCodePermission {
  readonly permissionOccurrenceId: string;
  readonly originalRequestId: string;
  readonly agentSessionId: string;
  readonly directory?: string;
  readonly operation: AgentRuntimeOperation;
}

type OpenCodeDecisionControllerOptions = OpenCodeQuestionControllerOptions;

export class OpenCodeDecisionController {
  readonly #pending = new Set<PendingOpenCodePermission>();
  readonly #questions: OpenCodeQuestionController;

  constructor(private readonly options: OpenCodeDecisionControllerOptions) {
    this.#questions = new OpenCodeQuestionController(options);
  }

  get idle(): boolean {
    return this.#pending.size === 0 && this.#questions.idle;
  }

  handle(
    client: any,
    event: SSEEvent,
    source: OpenCodeOperationEventSource,
    route: OpenCodeOperationRoute,
  ): boolean {
    if (event.type === 'question.asked') {
      this.#questions.handle(client, event, source, route);
      return true;
    }
    if (event.type !== 'permission.asked') return false;

    const toolMessageId = event.properties?.tool?.messageID;
    if (
      source.kind === 'operation'
      && typeof toolMessageId === 'string'
      && !route.turn.assistantMessageIds.has(toolMessageId)
    ) {
      this.options.logger.warn('Ignoring an OpenCode permission for a message outside its turn', {
        agentSessionId: route.sessionId,
        eventId: event.id ?? null,
        toolMessageId,
      });
      return true;
    }
    const permission = extractPermissionRequest(event);
    if (!permission) return true;
    if (route.permissionMode === 'manualBypass') {
      this.#replyManualBypass(client, route, permission.requestId);
      return true;
    }
    const permissionOccurrenceId = crypto.randomUUID();
    const pending: PendingOpenCodePermission = {
      permissionOccurrenceId,
      originalRequestId: permission.requestId,
      agentSessionId: route.sessionId,
      directory: route.directory,
      operation: route.turn.operation,
    };
    this.#pending.add(pending);
    const requestedTool = convertOpencodePermissionTool(
      new Date().toISOString(),
      permissionOccurrenceId,
      permission.toolInput,
    );
    this.options.publish(route.sessionId, route.turn.operation, {
      type: 'permission',
      runId: route.turn.operation.runId,
      lifecycle: {
        kind: 'requested',
        permissionOccurrenceId,
        requestedTool,
        options: [],
      },
      decision: Object.freeze({
        permissionOccurrenceId,
        respond: (decision: PermissionDecisionPayload) => this.#resolve(pending, decision),
      }),
    });
    return true;
  }

  cancelForSession(
    agentSessionId: string,
    reason: 'cancelled' | 'session-complete' | 'aborted',
  ): void {
    for (const pending of [...this.#pending]) {
      if (pending.agentSessionId !== agentSessionId) continue;
      this.#pending.delete(pending);
      this.options.publish(agentSessionId, pending.operation, {
        type: 'permission',
        runId: pending.operation.runId,
        lifecycle: {
          kind: 'cancelled',
          permissionOccurrenceId: pending.permissionOccurrenceId,
          reason,
        },
      });
    }
    this.#questions.cancelForSession(agentSessionId, reason);
  }

  clear(): void {
    this.#pending.clear();
    this.#questions.clear();
  }

  #replyManualBypass(
    client: any,
    route: OpenCodeOperationRoute,
    requestId: string,
  ): void {
    void this.options.runScopedRequest(
      'OpenCode manual bypass permission reply',
      { directory: route.directory },
      (signal, requestScope) => client.permission.reply(
        withOpenCodeRequestScope({ requestID: requestId, reply: 'once' }, requestScope),
        { signal },
      ),
    ).then((result) => {
      if (isOpenCodeNotFoundResult(result)) {
        this.options.logger.debug('Ignoring an OpenCode reply for a missing permission request', {
          agentSessionId: route.sessionId,
        });
        return;
      }
      throwOpenCodeResultError(result, 'OpenCode manual bypass permission reply failed');
    }).catch((error) => {
      const current = this.options.getSession(route.sessionId);
      if (current?.status !== 'running' || current.turn !== route.turn) {
        this.options.logger.debug('Ignoring a late OpenCode manual bypass reply failure', {
          agentSessionId: route.sessionId,
          error: errorMessage(error),
        });
        return;
      }
      this.options.failTurn(route.sessionId, current, errorMessage(error));
    });
  }

  async #resolve(
    pending: PendingOpenCodePermission,
    decision: Pick<PermissionDecisionPayload, 'allow' | 'alwaysAllow'>,
  ): Promise<void> {
    if (!this.#pending.has(pending)) {
      throw new Error('OpenCode permission occurrence is no longer pending');
    }
    const allow = Boolean(decision?.allow);
    const reply = mapPermissionDecision(decision);
    const client = await this.options.getClient();
    const result = await this.options.runScopedRequest(
      'OpenCode permission reply',
      { directory: pending.directory },
      (signal, requestScope) => client.permission.reply(
        withOpenCodeRequestScope({
          requestID: pending.originalRequestId,
          reply,
          message: allow ? undefined : 'User denied tool use',
        }, requestScope),
        { signal },
      ),
    );
    throwOpenCodeResultError(result, 'OpenCode permission reply failed');
    this.#pending.delete(pending);
  }
}
