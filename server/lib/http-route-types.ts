export type ServerPrincipal =
  | { mode: 'authenticated'; key: string; username: string; expiresAtMs: number }
  | { mode: 'local'; key: 'local'; username: 'local'; expiresAtMs: null };

export const LOCAL_SERVER_PRINCIPAL: ServerPrincipal = Object.freeze({
  mode: 'local',
  key: 'local',
  username: 'local',
  expiresAtMs: null,
});

export interface HttpRouteContext {
  principal: ServerPrincipal | null;
}

export type RouteHandler = (
  request: Request,
  url: URL,
  server?: unknown,
  context?: HttpRouteContext,
) => Promise<Response> | Response;

export type RouteMap = Record<string, Record<string, RouteHandler>>;
