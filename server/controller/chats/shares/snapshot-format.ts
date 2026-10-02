import type { SharedChatOrigin, SharedChatSnapshot } from '../../../../common/share-types.ts';
import { isRecord } from '../../../../common/json.js';

// Everything a share snapshot records except its messages.
export type ShareIndexEntry = Omit<SharedChatSnapshot, 'messages' | 'origin'>;
export type ShareSnapshotHeader = Omit<SharedChatSnapshot, 'messages'> & {
  readonly messageCount: number;
};

// A snapshot file holds its header on the first line and one message per line after it,
// so a reader serves a page of messages as the stored JSON without parsing the rest.
// JSON never contains a raw line feed, so each message stays on its own line.
export function encodeShareSnapshot(header: ShareSnapshotHeader, messages: readonly unknown[]): string {
  let text = JSON.stringify(header);
  for (const message of messages) text += `\n${JSON.stringify(message)}`;
  return text;
}

export function decodeShareSnapshot(
  token: string,
  text: string,
): { readonly header: ShareSnapshotHeader; readonly messages: readonly string[] } | null {
  const lines = text.split('\n');
  const header = decodeShareSnapshotHeader(token, lines[0]!);
  if (!header || header.messageCount !== lines.length - 1) return null;
  return { header, messages: lines.slice(1) };
}

export function decodeShareSnapshotHeader(token: string, line: string): ShareSnapshotHeader | null {
  try {
    return normalizeShareHeader(token, JSON.parse(line));
  } catch {
    return null;
  }
}

// Reads the single-document format written before messages moved one per line.
export function decodeLegacyShareSnapshot(token: string, value: unknown): SharedChatSnapshot | null {
  if (!isRecord(value)) return null;
  const entry = normalizeShareIndexEntry(token, value);
  if (!entry) return null;
  const messages = Array.isArray(value.messages) ? value.messages : [];
  const origin = normalizeOrigin(value.origin);
  return { ...entry, ...(origin ? { origin } : {}), messages };
}

export function isValidShareToken(token: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(token);
}

export function normalizeShareIndexEntry(token: string, value: unknown): ShareIndexEntry | null {
  if (!isRecord(value)) return null;
  const shareToken = typeof value.shareToken === 'string' ? value.shareToken : token;
  if (!isValidShareToken(shareToken)) return null;
  const chatId = typeof value.chatId === 'string' ? value.chatId : null;
  const title = typeof value.title === 'string' ? value.title : null;
  const agentId = typeof value.agentId === 'string' ? value.agentId : null;
  const model = typeof value.model === 'string' ? value.model : null;
  const projectPath = typeof value.projectPath === 'string' ? value.projectPath : null;
  const sharedAt = typeof value.sharedAt === 'string' ? value.sharedAt : null;
  if (!chatId || !title || !agentId || !model || !projectPath || !sharedAt) return null;
  return { shareToken, chatId, title, agentId, model, projectPath, sharedAt };
}

function normalizeShareHeader(token: string, value: unknown): ShareSnapshotHeader | null {
  const entry = normalizeShareIndexEntry(token, value);
  if (!entry || !isRecord(value)) return null;
  const messageCount = value.messageCount;
  if (typeof messageCount !== 'number' || !Number.isSafeInteger(messageCount) || messageCount < 0) return null;
  const origin = normalizeOrigin(value.origin);
  return { ...entry, ...(origin ? { origin } : {}), messageCount };
}

function normalizeOrigin(value: unknown): SharedChatOrigin | undefined {
  if (!isRecord(value)) return undefined;
  const transcriptViewId = typeof value.transcriptViewId === 'string'
    ? value.transcriptViewId
    : null;
  const lastOrdinal = typeof value.lastOrdinal === 'number' && Number.isSafeInteger(value.lastOrdinal)
    ? value.lastOrdinal
    : null;
  if (!transcriptViewId || lastOrdinal === null || lastOrdinal < 0) return undefined;
  return { transcriptViewId, lastOrdinal };
}
