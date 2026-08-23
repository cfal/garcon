import type { AgentLogger } from '@garcon/server-agent-interface';
import type { PermissionMode } from '@garcon/common/chat-modes';
import { GARCON_OPERATION_PART_METADATA_KEY } from './prompt.js';
import type { SSEEvent } from './sse-events.js';
import type { OpenCodeTurnContext } from './turn-events.js';

export interface OpenCodeOperationRoute {
  readonly sessionId: string;
  readonly chatId: string;
  readonly turn: OpenCodeTurnContext;
  readonly supersedesChatSource: boolean;
  readonly permissionMode: PermissionMode;
  readonly directory: string | undefined;
  readonly registrationOrdinal: number;
  readonly requestAbortController: AbortController;
}

export type OpenCodeOperationEventSource =
  | { readonly kind: 'operation'; readonly sessionId: string }
  | { readonly kind: 'task-child'; readonly sessionId: string };

export type OpenCodeCompactionPartAdoption =
  | { readonly kind: 'adopted'; readonly route: OpenCodeOperationRoute }
  | { readonly kind: 'route-retired' }
  | { readonly kind: 'invalid-identifiers' }
  | { readonly kind: 'identity-collision' };

export class OpenCodeOperationRoutes {
  readonly #byPart = new Map<string, OpenCodeOperationRoute>();
  readonly #byMessage = new Map<string, OpenCodeOperationRoute>();
  readonly #byTurn = new Map<OpenCodeTurnContext, OpenCodeOperationRoute>();
  readonly #byTaskChildSession = new Map<string, OpenCodeOperationRoute>();
  readonly #latestBoundOrdinalBySession = new Map<string, number>();
  #nextRegistrationOrdinal = 1;

  constructor(private readonly logger: AgentLogger) {}

  register(
    sessionId: string,
    chatId: string,
    turn: OpenCodeTurnContext,
    supersedesChatSource: boolean,
    permissionMode: PermissionMode,
    directory: string | undefined,
  ): OpenCodeOperationRoute {
    if (this.#byTaskChildSession.has(sessionId)) {
      throw new Error(`OpenCode session ${sessionId} is already routed as a task child`);
    }
    const route = {
      sessionId,
      chatId,
      turn,
      supersedesChatSource,
      permissionMode,
      directory,
      registrationOrdinal: this.#nextRegistrationOrdinal,
      requestAbortController: new AbortController(),
    };
    this.#nextRegistrationOrdinal += 1;
    const key = routeKey(sessionId, turn.providerPromptPartId);
    if (this.#byPart.has(key)) {
      throw new Error(`OpenCode prompt part ${turn.providerPromptPartId} is already routed`);
    }
    this.#byPart.set(key, route);
    this.#byTurn.set(turn, route);
    return route;
  }

  bindPart(turn: OpenCodeTurnContext, partId: string): boolean {
    const route = this.#byTurn.get(turn);
    if (!route) return false;
    return this.#bindPart(route, partId);
  }

  unbindPart(turn: OpenCodeTurnContext, partId: string): void {
    const route = this.#byTurn.get(turn);
    if (!route) return;
    const key = routeKey(route.sessionId, partId);
    if (this.#byPart.get(key) === route) this.#byPart.delete(key);
  }

  resolveNamed(sessionId: string, event: SSEEvent): OpenCodeOperationRoute | null {
    const part = event.properties?.part;
    const info = event.properties?.info;
    const tool = event.properties?.tool;
    const ids = [
      typeof part?.id === 'string' ? part.id : null,
      typeof part?.messageID === 'string' ? part.messageID : null,
      typeof info?.parentID === 'string' ? info.parentID : null,
      typeof info?.id === 'string' ? info.id : null,
      typeof event.properties?.messageID === 'string' ? event.properties.messageID : null,
      typeof tool?.messageID === 'string' ? tool.messageID : null,
    ];
    for (const id of ids) {
      if (!id) continue;
      const key = routeKey(sessionId, id);
      const route = this.#byPart.get(key) ?? this.#byMessage.get(key);
      if (route) return route;
    }
    return null;
  }

  resolve(sessionId: string, event: SSEEvent): OpenCodeOperationRoute | null {
    const named = this.resolveNamed(sessionId, event);
    if (named) return named;

    const part = event.type === 'message.part.updated' ? event.properties?.part : null;
    const partId = typeof part?.id === 'string' ? part.id : '';
    const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
    if (!partId || !messageId) return null;

    const inheritedOperationPartId = partOperationIdentity(part);
    const inheritedRoute = inheritedOperationPartId
      ? this.#byPart.get(routeKey(sessionId, inheritedOperationPartId))
      : undefined;
    const route = inheritedRoute;
    if (!route || !this.#bindContinuation(route, partId, messageId)) return null;

    route.turn.observedUserMessageIds.add(messageId);
    route.turn.providerContinuationMessageIds.add(messageId);
    return route;
  }

  adoptCompactionPart(
    turn: OpenCodeTurnContext,
    event: SSEEvent,
  ): OpenCodeCompactionPartAdoption {
    const route = this.#byTurn.get(turn);
    if (!route) return { kind: 'route-retired' };
    const part = event.properties?.part;
    const partId = typeof part?.id === 'string' ? part.id : '';
    const messageId = typeof part?.messageID === 'string' ? part.messageID : '';
    if (!partId || !messageId) return { kind: 'invalid-identifiers' };
    if (!this.#tryBindContinuation(route, partId, messageId)) {
      return { kind: 'identity-collision' };
    }
    route.turn.observedUserMessageIds.add(messageId);
    route.turn.providerContinuationMessageIds.add(messageId);
    return { kind: 'adopted', route };
  }

  bindTaskChildSession(route: OpenCodeOperationRoute, event: SSEEvent): boolean {
    if (!this.isRegistered(route)) return false;
    const childSessionId = taskChildSessionId(event);
    if (!childSessionId || childSessionId === route.sessionId) return false;
    return this.#bindTaskChildSession(route, childSessionId);
  }

  // Affiliates nested tasks only through a parent already bound by task-part metadata.
  // https://github.com/anomalyco/opencode/blob/2b72179c663cadcb54f54d9f19221b3fb3d11fb6/packages/opencode/src/tool/task.ts#L158-L195
  bindTaskDescendantSession(event: SSEEvent): OpenCodeOperationRoute | null {
    const created = taskChildCreation(event);
    if (!created) return null;
    const route = this.resolveTaskChild(created.parentSessionId);
    if (!route || !this.#bindTaskChildSession(route, created.childSessionId)) return null;
    return route;
  }

  #bindTaskChildSession(route: OpenCodeOperationRoute, childSessionId: string): boolean {
    const existingChildRoute = this.#byTaskChildSession.get(childSessionId);
    const existingSessionRoute = [...this.#byTurn.values()]
      .find((candidate) => candidate.sessionId === childSessionId);
    if (
      (existingChildRoute && existingChildRoute !== route)
      || (existingSessionRoute && existingSessionRoute !== route)
    ) {
      this.logger.warn('Ignoring an OpenCode task child session identity collision', {
        parentSessionId: route.sessionId,
        childSessionId,
      });
      return false;
    }
    this.#byTaskChildSession.set(childSessionId, route);
    return true;
  }

  resolveTaskChild(sessionId: string): OpenCodeOperationRoute | null {
    const route = this.#byTaskChildSession.get(sessionId);
    return route && this.isRegistered(route) ? route : null;
  }

  observe(route: OpenCodeOperationRoute, event: SSEEvent): void {
    const part = event.properties?.part;
    if (part?.id === route.turn.providerPromptPartId) {
      const providerMessageId = typeof part.messageID === 'string' ? part.messageID : '';
      if (!providerMessageId) return;
      this.#activateSource(route, providerMessageId);
    }

    const info = event.properties?.info;
    if (info?.role === 'assistant' && typeof info.id === 'string' && info.id) {
      this.#bindMessage(route, info.id);
    }
    if (typeof part?.messageID === 'string' && part.messageID) {
      this.#bindMessage(route, part.messageID);
    }
  }

  unregister(route: OpenCodeOperationRoute): void {
    this.#retireRoute(route);
  }

  retireTurn(turn: OpenCodeTurnContext): void {
    const route = this.#byTurn.get(turn);
    if (route) this.#retireRoute(route);
  }

  cancelRequest(turn: OpenCodeTurnContext, reason: Error): void {
    this.#byTurn.get(turn)?.requestAbortController.abort(reason);
  }

  isRegistered(route: OpenCodeOperationRoute): boolean {
    return this.#byTurn.get(route.turn) === route;
  }

  activateFromResponse(route: OpenCodeOperationRoute, providerMessageId: string): boolean {
    if (!this.isRegistered(route)) return false;
    this.#activateSource(route, providerMessageId);
    return true;
  }

  clear(): void {
    for (const route of new Set(this.#byTurn.values())) {
      route.requestAbortController.abort(new Error('OpenCode provider event source retired'));
    }
    this.#byPart.clear();
    this.#byMessage.clear();
    this.#byTurn.clear();
    this.#byTaskChildSession.clear();
    this.#latestBoundOrdinalBySession.clear();
  }

  #activateSource(route: OpenCodeOperationRoute, providerMessageId: string): void {
    this.#bindMessage(route, providerMessageId);
    const latestBoundOrdinal = this.#latestBoundOrdinalBySession.get(route.sessionId) ?? 0;
    if (latestBoundOrdinal > route.registrationOrdinal) return;
    if (route.supersedesChatSource) {
      for (const existing of new Set(this.#byPart.values())) {
        if (
          existing.chatId === route.chatId
          && existing.registrationOrdinal < route.registrationOrdinal
        ) this.#retireRoute(existing);
      }
    }
    this.#latestBoundOrdinalBySession.set(route.sessionId, route.registrationOrdinal);
  }

  #bindPart(route: OpenCodeOperationRoute, partId: string): boolean {
    const key = routeKey(route.sessionId, partId);
    const existing = this.#byPart.get(key);
    if (existing === route) return true;
    if (existing) {
      this.logger.warn('Ignoring an OpenCode operation identity collision', {
        sessionId: route.sessionId,
        partId,
      });
      return false;
    }
    this.#byPart.set(key, route);
    return true;
  }

  #bindContinuation(
    route: OpenCodeOperationRoute,
    partId: string,
    messageId: string,
  ): boolean {
    if (this.#tryBindContinuation(route, partId, messageId)) return true;
    this.logger.warn('Ignoring an OpenCode operation identity collision', {
      sessionId: route.sessionId,
      partId,
      messageId,
    });
    return false;
  }

  #tryBindContinuation(
    route: OpenCodeOperationRoute,
    partId: string,
    messageId: string,
  ): boolean {
    const partKey = routeKey(route.sessionId, partId);
    const messageKey = routeKey(route.sessionId, messageId);
    const partRoute = this.#byPart.get(partKey);
    const messageRoute = this.#byMessage.get(messageKey);
    if ((partRoute && partRoute !== route) || (messageRoute && messageRoute !== route)) {
      return false;
    }
    this.#byPart.set(partKey, route);
    this.#byMessage.set(messageKey, route);
    return true;
  }

  #bindMessage(route: OpenCodeOperationRoute, messageId: string): void {
    const key = routeKey(route.sessionId, messageId);
    const existing = this.#byMessage.get(key);
    if (existing === route) return;
    if (existing) {
      this.logger.warn('Ignoring an OpenCode operation identity collision', {
        sessionId: route.sessionId,
        messageId,
      });
      return;
    }
    this.#byMessage.set(key, route);
  }

  #retireRoute(route: OpenCodeOperationRoute): void {
    route.requestAbortController.abort(new Error('OpenCode operation route retired'));
    for (const [key, candidate] of this.#byPart) {
      if (candidate === route) this.#byPart.delete(key);
    }
    for (const [key, candidate] of this.#byMessage) {
      if (candidate === route) this.#byMessage.delete(key);
    }
    for (const [sessionId, candidate] of this.#byTaskChildSession) {
      if (candidate === route) this.#byTaskChildSession.delete(sessionId);
    }
    this.#byTurn.delete(route.turn);
    const sessionStillRouted = [...this.#byTurn.values()]
      .some((candidate) => candidate.sessionId === route.sessionId);
    if (!sessionStillRouted) this.#latestBoundOrdinalBySession.delete(route.sessionId);
  }
}

function taskChildSessionId(event: SSEEvent): string | null {
  if (event.type !== 'message.part.updated') return null;
  const part = event.properties?.part;
  if (part?.type !== 'tool' || part.tool !== 'task') return null;
  const state = part.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  const metadata = (state as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const sessionId = (metadata as Record<string, unknown>).sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : null;
}

function taskChildCreation(event: SSEEvent): {
  childSessionId: string;
  parentSessionId: string;
} | null {
  if (event.type !== 'session.created') return null;
  const sessionId = event.properties?.sessionID;
  const info = event.properties?.info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const childSessionId = (info as Record<string, unknown>).id;
  const parentSessionId = (info as Record<string, unknown>).parentID;
  if (
    typeof sessionId !== 'string'
    || !sessionId
    || childSessionId !== sessionId
    || typeof parentSessionId !== 'string'
    || !parentSessionId
    || parentSessionId === childSessionId
  ) return null;
  return { childSessionId, parentSessionId };
}

function partOperationIdentity(part: Record<string, unknown>): string | null {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  const operationPartId = (metadata as Record<string, unknown>)[GARCON_OPERATION_PART_METADATA_KEY];
  return typeof operationPartId === 'string' && operationPartId ? operationPartId : null;
}

function routeKey(sessionId: string, providerId: string): string {
  return `${sessionId}\0${providerId}`;
}
