// Telegram Bot API client. Sends plain-text messages via the sendMessage
// endpoint. Failures are logged but never thrown to avoid breaking chat
// execution.

const TELEGRAM_API = 'https://api.telegram.org';

export class TelegramNotifier {
  #botToken: string;

  constructor(botToken: string) {
    this.#botToken = botToken;
  }

  get isConfigured(): boolean {
    return Boolean(this.#botToken);
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
}
