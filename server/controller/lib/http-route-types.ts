export type ServerPrincipal =
  | { mode: 'executor'; key: string; executorId: string; expiresAtMs: null }
  | { mode: 'authenticated'; key: string; username: string; expiresAtMs: number; credentialRevision: number; sessionId: string }
  | { mode: 'local'; key: 'local'; username: 'local'; expiresAtMs: null; authDisabled?: true };

export const LOCAL_SERVER_PRINCIPAL: ServerPrincipal = Object.freeze({
  mode: 'local',
  key: 'local',
  username: 'local',
  expiresAtMs: null,
});

// Distinguishes disabled-auth browser access from bearer-authenticated local capability calls.
export const AUTH_DISABLED_SERVER_PRINCIPAL: ServerPrincipal = Object.freeze({
  mode: 'local',
  key: 'local',
  username: 'local',
  expiresAtMs: null,
  authDisabled: true,
});

export interface HttpRouteContext {
  principal: ServerPrincipal | null;
  readonly assertCurrent?: () => void;
}

export type RouteHandler = (
  request: Request,
  url: URL,
  server?: unknown,
  context?: HttpRouteContext,
) => Promise<Response> | Response;

export type RouteMap = Record<string, Record<string, RouteHandler>>;
