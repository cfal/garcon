import type { AgentLogger } from '@garcon/server-agent-interface';
import type { PermissionMode } from '@garcon/common/chat-modes';
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
}

export class OpenCodeOperationRoutes {
  readonly #byPart = new Map<string, OpenCodeOperationRoute>();
  readonly #byMessage = new Map<string, OpenCodeOperationRoute>();
  readonly #byTurn = new Map<OpenCodeTurnContext, OpenCodeOperationRoute>();
  readonly #sourceBySession = new Map<string, OpenCodeOperationRoute>();
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
    const route = {
      sessionId,
      chatId,
      turn,
      supersedesChatSource,
      permissionMode,
      directory,
      registrationOrdinal: this.#nextRegistrationOrdinal,
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

  source(sessionId: string): OpenCodeOperationRoute | null {
    return this.#sourceBySession.get(sessionId) ?? null;
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

  clear(): void {
    this.#byPart.clear();
    this.#byMessage.clear();
    this.#byTurn.clear();
    this.#sourceBySession.clear();
  }

  #activateSource(route: OpenCodeOperationRoute, providerMessageId: string): void {
    this.#bindMessage(route, providerMessageId);
    const currentSource = this.#sourceBySession.get(route.sessionId);
    if (
      currentSource
      && currentSource.registrationOrdinal > route.registrationOrdinal
    ) return;
    if (route.supersedesChatSource) {
      for (const existing of new Set(this.#byPart.values())) {
        if (
          existing.chatId === route.chatId
          && existing.registrationOrdinal < route.registrationOrdinal
        ) this.#retireRoute(existing);
      }
    }
    this.#sourceBySession.set(route.sessionId, route);
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
    for (const [key, candidate] of this.#byPart) {
      if (candidate === route) this.#byPart.delete(key);
    }
    for (const [key, candidate] of this.#byMessage) {
      if (candidate === route) this.#byMessage.delete(key);
    }
    if (this.#sourceBySession.get(route.sessionId) === route) {
      this.#sourceBySession.delete(route.sessionId);
    }
    this.#byTurn.delete(route.turn);
  }
}

function routeKey(sessionId: string, providerId: string): string {
  return `${sessionId}\0${providerId}`;
}
