// Share routes. Provides endpoints to create, query, revoke, and
// publicly access shared chat snapshots.

import { markRouteNoAuth } from '../lib/http-route.js';
import { withJsonBody } from '../lib/json-route.js';
import type { IShareStore } from '../chats/share-store.js';
import type { IChatRegistry } from '../chats/store.js';
import type {
  GetSharedChatResponse,
  RevokeShareResponse,
  ShareChatResponse,
  SharedChatSnapshot,
  ShareStatusResponse,
} from '../../common/share-types.ts';
import { renderSharedChatText } from '../chats/share-transcript.ts';
import {
  injectSharedChatContext,
  renderStandaloneSharedHtml,
} from '../chats/share-page.ts';
import { loadStaticText } from './static.js';
import { extractFirstLine } from '../lib/text.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import { isDomainError } from '../lib/domain-error.js';
import {
  injectAppTitleIntoShell,
  resolvePublicAppTitle,
} from '../app-title.js';

interface SettingsDep {
  getChatName(chatId: string): string | null;
  getUiSettings(): Record<string, unknown>;
  getRemoteSettingsVersion(): number;
}

interface MetadataDep {
  getChatMetadata(chatId: string): ChatMetadata | null;
}

export interface ShareTranscriptSnapshotPort {
  renderingSnapshot(chatId: string): Promise<{
    readonly transcriptViewId: string;
    readonly lastOrdinal: number;
    readonly messages: readonly unknown[];
  }>;
}


function extractLlmTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/shared\/llm\/([^/]+)$/);
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function extractShareTokenFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/shared\/([^/]+)$/);
  if (!match?.[1]) return null;

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const MAX_SHARED_CHAT_PAGE_SIZE = 200;
const NO_STORE = 'no-cache, no-store, must-revalidate';

function htmlResponse(html: string, llmPath?: string): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': NO_STORE,
    Vary: 'Accept',
  };
  if (llmPath) {
    headers.Link = `<${llmPath}>; rel="alternate"; type="text/plain"`;
  }
  return new Response(html, {
    headers,
  });
}

function parseMessageCursor(
  value: string | null,
  totalMessages: number,
): number {
  if (value === null) return totalMessages;
  if (!/^\d+$/.test(value)) return totalMessages;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return totalMessages;
  return Math.max(0, Math.min(parsed, totalMessages));
}

function parsePageSize(value: string | null, totalMessages: number): number {
  // Preserve the original full-snapshot API when pagination is not requested.
  if (value === null) return totalMessages;
  if (!/^\d+$/.test(value)) return MAX_SHARED_CHAT_PAGE_SIZE;
  return Math.max(1, Math.min(Number(value), MAX_SHARED_CHAT_PAGE_SIZE));
}

type SharedRepresentation = 'html' | 'text';

interface AcceptMatch {
  quality: number;
  specificity: number;
  position: number;
}

function matchAcceptedType(
  accept: string,
  candidate: 'text/html' | 'text/plain',
): AcceptMatch | null {
  const [candidateType, candidateSubtype] = candidate.split('/');
  let best: AcceptMatch | null = null;

  for (const [position, entry] of accept.split(',').entries()) {
    const [rawRange, ...rawParameters] = entry.split(';');
    const [type, subtype] = rawRange.trim().toLowerCase().split('/');
    if (!type || !subtype) continue;
    if (type !== '*' && type !== candidateType) continue;
    if (subtype !== '*' && subtype !== candidateSubtype) continue;

    let quality = 1;
    for (const parameter of rawParameters) {
      const [name, value] = parameter.split('=').map((part) => part.trim());
      if (name?.toLowerCase() !== 'q') continue;
      const parsed = Number(value);
      quality =
        Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }

    const specificity = type === '*' ? 0 : subtype === '*' ? 1 : 2;
    const match = { quality, specificity, position };
    if (
      !best ||
      specificity > best.specificity ||
      (specificity === best.specificity && quality > best.quality)
    ) {
      best = match;
    }
  }

  return best;
}

function negotiateSharedRepresentation(
  request: Request,
): SharedRepresentation | null {
  const accept = request.headers.get('accept')?.trim();
  // Preserve direct readability for generic agents and crawlers. Browser
  // navigations explicitly advertise text/html.
  if (!accept) return 'text';

  const candidates: Array<{
    representation: SharedRepresentation;
    match: AcceptMatch;
  }> = [];
  const text = matchAcceptedType(accept, 'text/plain');
  const html = matchAcceptedType(accept, 'text/html');
  if (text && text.quality > 0)
    candidates.push({ representation: 'text', match: text });
  if (html && html.quality > 0)
    candidates.push({ representation: 'html', match: html });

  candidates.sort(
    (left, right) =>
      right.match.quality - left.match.quality ||
      right.match.specificity - left.match.specificity ||
      left.match.position - right.match.position,
  );
  return candidates[0]?.representation ?? null;
}

function plainTextResponse(snapshot: SharedChatSnapshot): Response {
  return new Response(renderSharedChatText(snapshot), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': NO_STORE,
      Vary: 'Accept',
    },
  });
}

function publicJsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': NO_STORE },
  });
}

export default function createShareRoutes(
  shareStore: IShareStore,
  registry: IChatRegistry,
  settings: SettingsDep,
  metadata: MetadataDep,
  transcripts: ShareTranscriptSnapshotPort,
): RouteMap {
  // POST /api/v1/chats/share - Creates or returns existing share.
  async function postShareChat(
    body: Record<string, unknown>,
  ): Promise<Response> {
    try {
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return Response.json(
          { success: false, error: 'chatId is required' },
          { status: 400 },
        );
      }

      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json(
          { success: false, error: 'Session not found' },
          { status: 404 },
        );
      }

      const capture = await transcripts.renderingSnapshot(chatId);

      const meta = metadata.getChatMetadata(chatId);
      const overrideTitle = settings.getChatName(chatId);
      const title = extractFirstLine(
        (overrideTitle || meta?.firstMessage || 'Untitled Chat') as string,
      );

      const partial = {
        chatId,
        title,
        agentId: session.agentId as string,
        model: session.model as string,
        projectPath: session.projectPath as string,
        sharedAt: new Date().toISOString(),
        origin: {
          transcriptViewId: capture.transcriptViewId,
          lastOrdinal: capture.lastOrdinal,
        },
        messages: [...capture.messages],
      };

      // Update existing share with latest messages, or create a new one.
      const existing = await shareStore.getShareByChatId(chatId);
      const snapshot = existing
        ? await shareStore.updateShare(chatId, partial)
        : await shareStore.createShare(chatId, partial);

      const resp: ShareChatResponse = {
        success: true,
        shareToken: snapshot.shareToken,
        shareUrl: `/shared/${snapshot.shareToken}`,
      };
      return Response.json(resp);
    } catch (error: unknown) {
      if (isDomainError(error)) {
        return Response.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 500 },
      );
    }
  }

  // DELETE /api/v1/chats/share?chatId=X - Revokes a share.
  async function deleteShareChat(
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      return Response.json(
        { success: false, error: 'chatId query parameter is required' },
        { status: 400 },
      );
    }

    try {
      const revoked = await shareStore.revokeShareByChatId(chatId);
      const resp: RevokeShareResponse = { success: revoked };
      return Response.json(resp, { status: revoked ? 200 : 404 });
    } catch (error: unknown) {
      return Response.json(
        { success: false, error: (error as Error).message },
        { status: 500 },
      );
    }
  }

  // GET /api/v1/chats/share/status?chatId=X - Checks share status.
  async function getShareStatus(
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      return Response.json(
        { success: false, error: 'chatId query parameter is required' },
        { status: 400 },
      );
    }

    const existing = await shareStore.getShareByChatId(chatId);
    const resp: ShareStatusResponse = existing
      ? {
          isShared: true,
          shareToken: existing.shareToken,
          shareUrl: `/shared/${existing.shareToken}`,
          sharedAt: existing.sharedAt,
        }
      : { isShared: false };
    return Response.json(resp);
  }

  // GET /api/v1/shared - Public endpoint, returns snapshot by token.
  const getSharedChat = markRouteNoAuth(async function getSharedChat(
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const token = url.searchParams.get('token');
    if (!token) {
      return publicJsonResponse(
        { error: 'token query parameter is required' },
        400,
      );
    }

    const snapshot = await shareStore.getShare(token);
    if (!snapshot) {
      return publicJsonResponse({ error: 'Share not found' }, 404);
    }

    const totalMessages = snapshot.messages.length;
    const requestedBefore = url.searchParams.get('before');
    const requestedVersion = url.searchParams.get('version');
    const cursorIsStale =
      requestedBefore !== null &&
      requestedVersion !== null &&
      requestedVersion !== snapshot.sharedAt;
    const end = parseMessageCursor(
      cursorIsStale ? null : requestedBefore,
      totalMessages,
    );
    const pageSize = parsePageSize(
      url.searchParams.get('limit'),
      totalMessages,
    );
    const start = Math.max(0, end - pageSize);
    const resp: GetSharedChatResponse = {
      snapshot: { ...snapshot, messages: snapshot.messages.slice(start, end) },
      page: {
        snapshotVersion: snapshot.sharedAt,
        totalMessages,
        start,
        end,
        nextBefore: start > 0 ? start : null,
        ...(cursorIsStale ? { reset: true } : {}),
      },
    };
    return publicJsonResponse(resp);
  });

  // Serves a plain text transcript at /shared/llm/:token for LLM consumption.
  const getLlmTranscript = markRouteNoAuth(async function getLlmTranscript(
    _request: Request,
    url: URL,
  ): Promise<Response> {
    const token = extractLlmTokenFromPath(url.pathname);
    if (!token) {
      return publicJsonResponse({ error: 'Share token is required' }, 400);
    }

    const snapshot = await shareStore.getShare(token);
    if (!snapshot) {
      return publicJsonResponse({ error: 'Share not found' }, 404);
    }

    return plainTextResponse(snapshot);
  });

  // Serves the shared chat page at /shared/:token. Enriches the SPA shell with
  // share metadata and bounded transcript discovery so large chats stay fast.
  const getSharedChatPage = markRouteNoAuth(async function getSharedChatPage(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const shell = await loadStaticText('/index.html');
    const token = extractShareTokenFromPath(url.pathname);
    const snapshot = token ? await shareStore.getShare(token) : null;
    const appTitle = resolvePublicAppTitle(
      settings.getUiSettings(),
      settings.getRemoteSettingsVersion(),
    );

    // Without a snapshot, fall back to the unmodified shell so the client renders
    // its own not-found view (and keeps client-side routing intact).
    if (!snapshot || !token) {
      return shell
        ? htmlResponse(injectAppTitleIntoShell(shell, appTitle))
        : new Response('Not found', { status: 404 });
    }

    const representation = negotiateSharedRepresentation(request);
    if (representation === 'text') return plainTextResponse(snapshot);
    if (!representation) {
      return new Response('Not acceptable', {
        status: 406,
        headers: { 'Cache-Control': NO_STORE, Vary: 'Accept' },
      });
    }

    const canonicalUrl = `${url.origin}/shared/${encodeURIComponent(token)}`;
    const llmPath = `/shared/llm/${encodeURIComponent(token)}`;
    const html = shell
      ? injectSharedChatContext(shell, snapshot, token, canonicalUrl, appTitle)
      : renderStandaloneSharedHtml(snapshot, token, canonicalUrl, appTitle);
    return htmlResponse(html, llmPath);
  });

  return {
    '/api/v1/chats/share': {
      POST: withJsonBody(postShareChat),
      DELETE: deleteShareChat,
    },
    '/api/v1/chats/share/status': { GET: getShareStatus },
    '/api/v1/shared': { GET: getSharedChat },
    '/shared/:token': { GET: getSharedChatPage },
    '/shared/llm/:token': { GET: getLlmTranscript },
  };
}
