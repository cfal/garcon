// Share routes. Provides endpoints to create, query, revoke, and
// publicly access shared chat snapshots.

import { markRouteNoAuth } from '../lib/http-route.js';
import { withJsonBody } from '../lib/json-route.js';
import type { IShareStore } from '../chats/share-store.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ShareChatResponse, ShareStatusResponse, GetSharedChatResponse, RevokeShareResponse } from '../../common/share-types.ts';
import { renderSharedChatText } from '../chats/share-transcript.ts';
import { injectSharedChatContext, renderStandaloneSharedHtml } from '../chats/share-page.ts';
import { loadStaticText } from './static.js';
import { extractFirstLine } from '../lib/text.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { ChatViewPageReader } from '../chats/chat-message-reader.js';
import type { ChatMetadata } from '../chats/metadata-store.js';
import { injectAppTitleIntoShell, resolvePublicAppTitle } from '../app-title.js';

interface SettingsDep {
  getChatName(chatId: string): string | null;
  getUiSettings(): Record<string, unknown>;
  getRemoteSettingsVersion(): number;
}

interface MetadataDep {
  getChatMetadata(chatId: string): ChatMetadata | null;
}

type ChatViewsDep = ChatViewPageReader;

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

function htmlResponse(html: string): Response {
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
  });
}

export default function createShareRoutes(
  shareStore: IShareStore,
  registry: IChatRegistry,
  settings: SettingsDep,
  metadata: MetadataDep,
  chatViews: ChatViewsDep,
): RouteMap {

  // POST /api/v1/chats/share - Creates or returns existing share.
  async function postShareChat(body: Record<string, unknown>): Promise<Response> {
    try {
      const chatId = String(body.chatId || '').trim();
      if (!chatId) {
        return Response.json({ success: false, error: 'chatId is required' }, { status: 400 });
      }

      const session = registry.getChat(chatId);
      if (!session) {
        return Response.json({ success: false, error: 'Session not found' }, { status: 404 });
      }

      const page = await chatViews.getOrCreatePage(chatId, 100_000);
      const messages = page.messages.map((entry) => entry.message);

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
  async function getShareStatus(_request: Request, url: URL): Promise<Response> {
    const chatId = url.searchParams.get('chatId');
    if (!chatId) {
      return Response.json({ success: false, error: 'chatId query parameter is required' }, { status: 400 });
    }

    const existing = await shareStore.getShareByChatId(chatId);
    const resp: ShareStatusResponse = existing
      ? { isShared: true, shareToken: existing.shareToken, shareUrl: `/shared/${existing.shareToken}`, sharedAt: existing.sharedAt }
      : { isShared: false };
    return Response.json(resp);
  }

  // GET /api/v1/shared - Public endpoint, returns snapshot by token.
  const getSharedChat = markRouteNoAuth(async function getSharedChat(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('token');
    if (!token) {
      return Response.json({ error: 'token query parameter is required' }, { status: 400 });
    }

    const snapshot = await shareStore.getShare(token);
    if (!snapshot) {
      return Response.json({ error: 'Share not found' }, { status: 404 });
    }

    const resp: GetSharedChatResponse = { snapshot };
    return Response.json(resp);
  });

  // Serves a plain text transcript at /shared/llm/:token for LLM consumption.
  const getLlmTranscript = markRouteNoAuth(async function getLlmTranscript(_request: Request, url: URL): Promise<Response> {
    const token = extractLlmTokenFromPath(url.pathname);
    if (!token) {
      return Response.json({ error: 'Share token is required' }, { status: 400 });
    }

    const snapshot = await shareStore.getShare(token);
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

  // Serves the shared chat page at /shared/:token. Enriches the SPA shell with
  // share metadata and an agent-readable transcript fallback so a shared link is
  // both human-friendly and scrapable by agents that do not execute JavaScript.
  const getSharedChatPage = markRouteNoAuth(async function getSharedChatPage(_request: Request, url: URL): Promise<Response> {
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

    const canonicalUrl = `${url.origin}/shared/${encodeURIComponent(token)}`;
    const html = shell
      ? injectSharedChatContext(shell, snapshot, token, canonicalUrl, appTitle)
      : renderStandaloneSharedHtml(snapshot, token, canonicalUrl, appTitle);
    return htmlResponse(html);
  });

  return {
    '/api/v1/chats/share': { POST: withJsonBody(postShareChat), DELETE: deleteShareChat },
    '/api/v1/chats/share/status': { GET: getShareStatus },
    '/api/v1/shared': { GET: getSharedChat },
    '/shared/:token': { GET: getSharedChatPage },
    '/shared/llm/:token': { GET: getLlmTranscript },
  };
}
