// Telegram Bot API client. Route-level operations throw useful errors, while
// runtime notification sends log failures and return false so chat execution
// is never interrupted.

const TELEGRAM_API = 'https://api.telegram.org';

export interface TelegramBotIdentity {
  id: number;
  username: string;
  firstName: string;
}

export interface TelegramResolvedRecipient {
  chatId: string;
  username: string | null;
  displayName: string | null;
  nextOffset: number | null;
}

export interface TelegramLinkResolution {
  recipient: TelegramResolvedRecipient | null;
  nextOffset: number | null;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

interface TelegramUserPayload {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessagePayload {
  text?: string;
  from?: TelegramUserPayload;
  chat?: {
    id?: number | string;
    type?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    title?: string;
  };
}

interface TelegramUpdatePayload {
  update_id?: number;
  message?: TelegramMessagePayload;
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/^@+/, '').toLowerCase();
}

function displayNameFromUser(user: TelegramUserPayload | undefined): string | null {
  if (!user) return null;
  const parts = [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length > 0 ? parts.join(' ') : null;
}

function displayNameFromChat(chat: TelegramMessagePayload['chat'] | undefined): string | null {
  if (!chat) return null;
  const parts = [chat.first_name, chat.last_name]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length > 0 ? parts.join(' ') : null;
}

function startPayloadFromText(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.trim().match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);
  return match?.[1]?.trim() ?? null;
}

export class TelegramNotifier {
  #botToken: string;

  constructor(botToken: string) {
    this.#botToken = botToken;
  }

  setBotToken(botToken: string): void {
    this.#botToken = botToken;
  }

  get isConfigured(): boolean {
    return Boolean(this.#botToken);
  }

  async getBotIdentity(botToken = this.#botToken): Promise<TelegramBotIdentity> {
    const result = await this.#request<TelegramUserPayload>('getMe', botToken);
    if (typeof result.id !== 'number') {
      throw new Error('Telegram getMe response did not include a bot id');
    }
    if (typeof result.username !== 'string' || !result.username.trim()) {
      throw new Error('Telegram getMe response did not include a bot username');
    }
    return {
      id: result.id,
      username: normalizeUsername(result.username),
      firstName: typeof result.first_name === 'string' ? result.first_name : '',
    };
  }

  async resolveRecipientLink(
    linkCode: string,
    offset: number | null,
    timeoutSeconds = 20,
  ): Promise<TelegramLinkResolution> {
    if (!this.#botToken) throw new Error('Telegram bot token is not configured');
    const code = linkCode.trim();
    if (!code) throw new Error('Telegram link code is not configured');

    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message'],
    };
    if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0) {
      payload.offset = offset;
    }

    const updates = await this.#request<TelegramUpdatePayload[]>('getUpdates', this.#botToken, payload);
    let nextOffset = offset;
    let recipient: TelegramResolvedRecipient | null = null;

    for (const update of Array.isArray(updates) ? updates : []) {
      if (typeof update.update_id === 'number') {
        nextOffset = Math.max(nextOffset ?? 0, update.update_id + 1);
      }
      const message = update.message;
      const payloadCode = startPayloadFromText(message?.text);
      if (payloadCode !== code) continue;
      if (message?.chat?.type !== 'private') continue;

      const chatId = message?.chat?.id;
      if (chatId === undefined || chatId === null) continue;
      const fromUsername = typeof message?.from?.username === 'string'
        ? normalizeUsername(message.from.username)
        : null;

      recipient = {
        chatId: String(chatId),
        username: fromUsername,
        displayName: displayNameFromUser(message?.from) ?? displayNameFromChat(message?.chat),
        nextOffset,
      };
      break;
    }

    return { recipient, nextOffset };
  }

  // Sends a message to the given Telegram chat.
  // Supports optional HTML parse mode for rich formatting.
  async send(chatId: string, text: string, parseMode?: 'HTML'): Promise<boolean> {
    if (!this.#botToken || !chatId) return false;
    try {
      const payload: Record<string, string> = { chat_id: chatId, text };
      if (parseMode) payload.parse_mode = parseMode;
      const res = await fetch(`${TELEGRAM_API}/bot${this.#botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.warn(`telegram: sendMessage failed (${res.status}): ${body}`);
        return false;
      }
      return true;
    } catch (err: unknown) {
      console.warn('telegram: send error:', (err as Error).message);
      return false;
    }
  }

  async #request<T>(method: string, botToken: string, payload?: Record<string, unknown>): Promise<T> {
    const token = botToken.trim();
    if (!token) throw new Error('Telegram bot token is not configured');
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    let body: TelegramApiResponse<T>;
    try {
      body = await res.json() as TelegramApiResponse<T>;
    } catch {
      throw new Error(`Telegram ${method} returned a non-JSON response`);
    }
    if (!res.ok || body.ok !== true || body.result === undefined) {
      const detail = body.description ? `: ${body.description}` : '';
      throw new Error(`Telegram ${method} failed${detail}`);
    }
    return body.result;
  }
}
