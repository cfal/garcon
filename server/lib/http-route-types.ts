export type RouteHandler = (request: Request, url: URL, server?: unknown) => Promise<Response> | Response;

export type RouteMap = Record<string, Record<string, RouteHandler>>;
