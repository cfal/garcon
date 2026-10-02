import type { ModelCatalogSnapshot } from '../agents/model-catalog-cache.js';

const CATALOG_RESPONSE_HEADERS = {
  'Cache-Control': 'private, no-cache',
};

function etagMatches(request: Request, etag: string): boolean {
  const header = request?.headers?.get?.('if-none-match');
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim())
    .some((candidate) => candidate === etag || candidate === '*');
}

export function catalogResponseFromSnapshot(request: Request, snapshot: ModelCatalogSnapshot): Response {
  const headers = {
    ...CATALOG_RESPONSE_HEADERS,
    ETag: snapshot.etag,
  };

  if (etagMatches(request, snapshot.etag)) {
    return new Response(null, { status: 304, headers });
  }

  return Response.json(snapshot.body, { headers });
}
