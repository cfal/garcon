// Share routes. Provides endpoints to create, query, revoke, and
// publicly access shared chat snapshots.

import { parseJsonBody } from '../lib/http-request.js';
import { markRouteNoAuth } from '../lib/http-route.js';
import type { IShareStore } from '../chats/share-store.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ShareChatResponse, ShareStatusResponse, GetSharedChatResponse, RevokeShareResponse } from '../../common/share-types.ts';
import { renderSharedChatText } from '../chats/share-transcript.ts';

type RouteHandler = (request: Request, url: URL) => Promise<Response> | Response;
type RouteMap = Record<string, Record<string, RouteHandler>>;

interface SettingsDep {
  getChatName(chatId: string): string | null;
}

interface MetadataDep {
  getChatMetadata(chatId: string): Record<string, unknown> | null;
}

interface HistoryCacheDep {
  ensureLoaded(chatId: string): Promise<void>;
  getPaginatedMessages(chatId: string, limit: number, offset: number): unknown;
}

function extractFirstLine(text: string | null | undefined): string {
  if (!text) return '';
  const nl = text.indexOf('\n');
  if (nl < 0) return text.trim();
  return text.slice(0, nl).trim();
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

export default function createShareRoutes(
  shareStore: IShareStore,
  registry: IChatRegistry,
  settings: SettingsDep,
  metadata: MetadataDep,
  historyCache: HistoryCacheDep,
): RouteMap {

  // POST /api/v1/chats/share - Creates or returns existing share.
  async function postShareChat(request: Request): Promise<Response> {
    try {
      const body = await parseJsonBody(request);
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }

      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      // Load current messages for the snapshot.
      await historyCache.ensureLoaded(chatId);
      const page = historyCache.getPaginatedMessages(chatId, 100_000, 0) as { messages?: unknown[] };
      const messages = page?.messages ?? [];

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
        messages,
      };

      // Update existing share with latest messages, or create a new one.
      const existing = shareStore.getShareByChatId(chatId);
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
      if ((error as Error).message === 'Malformed JSON') {
        return Response.json({ success: false, error: 'Malformed JSON' }, { status: 400 });
      }
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  // DELETE /api/v1/chats/share?chatId=X - Revokes a share.
  async function deleteShareChat(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      return Response.json({ success: false, error: 'chatId query parameter is required' }, { status: 400 });
    }

    try {
      const revoked = await shareStore.revokeShareByChatId(chatId);
      const resp: RevokeShareResponse = { success: revoked };
      return Response.json(resp, { status: revoked ? 200 : 404 });
    } catch (error: unknown) {
      return Response.json({ success: false, error: (error as Error).message }, { status: 500 });
    }
  }

  // GET /api/v1/chats/share/status?chatId=X - Checks share status.
  function getShareStatus(_request: Request, url: URL): Response {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      return Response.json({ success: false, error: 'chatId query parameter is required' }, { status: 400 });
    }

    const existing = shareStore.getShareByChatId(chatId);
    const resp: ShareStatusResponse = existing
      ? { isShared: true, shareToken: existing.shareToken, shareUrl: `/shared/${existing.shareToken}`, sharedAt: existing.sharedAt }
      : { isShared: false };
    return Response.json(resp);
  }

  // GET /api/v1/shared - Public endpoint, returns snapshot by token.
  const getSharedChat = markRouteNoAuth(function getSharedChat(_request: Request, url: URL): Response {
    const token = url.searchParams.get('token');
    if (!token) {
      return Response.json({ error: 'token query parameter is required' }, { status: 400 });
    }

    const snapshot = shareStore.getShare(token);
    if (!snapshot) {
      return Response.json({ error: 'Share not found' }, { status: 404 });
    }

    const resp: GetSharedChatResponse = { snapshot };
    return Response.json(resp);
  });

  // Serves a plain text transcript at /shared/llm/:token for LLM consumption.
  const getLlmTranscript = markRouteNoAuth(function getLlmTranscript(_request: Request, url: URL): Response {
    const token = extractLlmTokenFromPath(url.pathname);
    if (!token) {
      return Response.json({ error: 'Share token is required' }, { status: 400 });
    }

    const snapshot = shareStore.getShare(token);
    if (!snapshot) {
      return Response.json({ error: 'Share not found' }, { status: 404 });
    }

    return new Response(renderSharedChatText(snapshot), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      },
    });
  });

  return {
    '/api/v1/chats/share': { POST: postShareChat, DELETE: deleteShareChat },
    '/api/v1/chats/share/status': { GET: getShareStatus },
    '/api/v1/shared': { GET: getSharedChat },
    '/shared/llm/:token': { GET: getLlmTranscript },
  };
}
