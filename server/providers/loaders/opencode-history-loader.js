// Wraps OpenCode SDK API calls to match the interface expected by
// the metadata and history-cache loaders. Reads session history and
// preview data via the SDK rather than JSONL files.
//
// Both exported functions accept a getClient callback: () => Promise<client>.
// The composition root binds this to the OpenCodeProvider instance.

import { UserMessage, AssistantMessage, ThinkingMessage, ToolResultMessage } from '../../../common/chat-types.js';
import { convertOpenCodeToolUse } from '../converters/opencode-tool-use.js';

const PREVIEW_TAIL_MESSAGE_LIMIT = 20;

// Returns preview metadata for a session (title, last message, etc.).
// getClient: () => Promise<OpenCodeClient>
export async function getOpenCodePreviewFromSessionId(sessionId, getClient) {
  if (!sessionId) {
    console.error('opencode: preview fetch failed, sessionId is required');
    return null;
  }
  try {
    const client = await getClient();
    const result = await client.session.get({ sessionID: sessionId });
    const session = result.data;
    if (!session) {
      console.error(`opencode: preview fetch failed, no data:`, result);
      return null;
    }
    const messageResult = await client.session.messages({
      sessionID: sessionId,
      limit: PREVIEW_TAIL_MESSAGE_LIMIT,
    });
    const messages = Array.isArray(messageResult.data) ? messageResult.data : [];
    let lastMessage = '';
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const info = message.info || {};
      if (info.role === 'user') {
        const text = extractTextFromParts(message.parts || []);
        lastMessage = text.trim();
      } else if (info.role === 'assistant') {
        for (const part of (message.parts || [])) {
          if (part.type === 'text') {
            const text = part.text?.trim();
            lastMessage = text || '';
          }
        }
      }
      if (lastMessage) break;
    }

    return {
      // TODO: this is incorrect, we should be returning the first user message instead of the generated title.
      // TODO: is there a way to disable OpenCode title generation?
      firstMessage: session.title || 'Unknown OpenCode Session',
      lastMessage,
      lastActivity: session.time?.updated ? new Date(session.time.updated).toISOString() : null,
      createdAt: session.time?.created ? new Date(session.time.created).toISOString() : null,
    };
  } catch (err) {
    console.error(`opencode: preview fetch failed for ${sessionId}:`, err);
    return null;
  }
}

function extractTextFromParts(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text || '')
    .join('\n');
}

import { normalizeToolResultContent } from '../../chats/normalize.js';

// Fetches messages for an OpenCode session and returns ChatMessage[].
// getClient: () => Promise<OpenCodeClient>
export async function loadOpenCodeChatMessages(sessionId, getClient) {
  if (!sessionId) return [];
  try {
    const client = await getClient();
    const result = await client.session.messages({ sessionID: sessionId });
    const rawMessages = Array.isArray(result.data) ? result.data : [];

    const messages = [];
    for (const msg of rawMessages) {
      const info = msg.info || {};
      const ts = info.time?.created
        ? new Date(info.time.created).toISOString()
        : new Date().toISOString();

      if (info.role === 'user') {
        const text = extractTextFromParts(msg.parts || []);
        if (text?.trim()) {
          messages.push(new UserMessage(ts, text));
        }
        continue;
      }

      if (info.role === 'assistant') {
        // Emit thinking parts first
        for (const part of (msg.parts || [])) {
          if (part.type === 'reasoning') {
            const content = part.reasoning || part.text || '';
            if (content.trim()) {
              messages.push(new ThinkingMessage(ts, content));
            }
          }
        }

        // Emit text and tool-use parts
        for (const part of (msg.parts || [])) {
          if (part.type === 'text' && part.text?.trim()) {
            messages.push(new AssistantMessage(ts, part.text));
          } else if (part.type === 'tool') {
            const toolId = part.callID || part.id || '';
            messages.push(convertOpenCodeToolUse(ts, part));

            // Emit tool result if completed or errored
            if (part.state?.status === 'completed') {
              messages.push(new ToolResultMessage(ts, toolId, normalizeToolResultContent(part.state.output), false));
            } else if (part.state?.status === 'error') {
              messages.push(new ToolResultMessage(ts, toolId, normalizeToolResultContent(part.state.error || 'Error'), true));
            }
          }
        }
      }
    }

    return messages;
  } catch (err) {
    console.error(`opencode: failed to load chat messages for session ${sessionId}:`, err.message);
    return [];
  }
}
