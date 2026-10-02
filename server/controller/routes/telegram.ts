import { jsonError, jsonErrorFromUnknown } from '../../common/http-error.js';
import type { AgentRegistryServiceContract } from '../agents/registry.js';
import type { RouteMap } from '../lib/http-route-types.js';
import { withJsonBody } from '../lib/json-route.js';
import type { TelegramNotifier } from '../notifications/telegram.js';
import type { TelegramSettingsStore } from '../notifications/telegram-settings-store.js';
import { buildRemoteSettingsSnapshot } from '../settings/remote-snapshot.js';
import type { SettingsStore } from '../settings/store.js';
import { asJsonBody, errorMessage, jsonErrorFromCorruptStateFile, type JsonBody } from './route-helpers.js';

const TELEGRAM_LINK_POLL_SECONDS = 20;

function telegramTokenTestFailedResponse(error: unknown): Response {
  return jsonError('Telegram token test failed', 400, 'telegram_token_test_failed', false,
    error instanceof Error ? error.message : String(error));
}

export function createTelegramRoutes(
  settings: SettingsStore,
  agents: AgentRegistryServiceContract,
  telegramNotifier: TelegramNotifier,
  telegramSettings: TelegramSettingsStore,
  projectBasePath: string,
): RouteMap {
  async function postTelegramTest(_request: Request): Promise<Response> {
    try {
      if (!telegramNotifier?.isConfigured) {
        return jsonError('Telegram bot token is not configured', 400);
      }
      const chatId = telegramSettings?.getRecipientChatId?.() ?? '';
      if (!chatId) {
        return jsonError('Telegram recipient is not linked', 400);
      }
      const ok = await telegramNotifier.send(chatId, 'Garcon: test notification. Your Telegram integration is working.');
      if (!ok) {
        return jsonError('Telegram delivery failed. Check your bot token and linked recipient.', 502, 'telegram_delivery_failed', false);
      }
      return Response.json({ success: true });
    } catch (error) {
      const message = errorMessage(error);
      const status = message.startsWith('Telegram ') || message.includes('bot token') ? 400 : 500;
      return jsonErrorFromUnknown(error, status);
    }
  }

  async function putTelegramToken(body: JsonBody): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      const input = asJsonBody(body);
      const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';
      if (!botToken) {
        return jsonError('botToken is required', 400, 'telegram_bot_token_required', false);
      }
      let identity;
      try {
        identity = await telegramNotifier.getBotIdentity(botToken);
      } catch (error) {
        return telegramTokenTestFailedResponse(error);
      }
      await telegramSettings.setBotToken(botToken, identity);
      telegramNotifier?.setBotToken?.(botToken);
      await telegramSettings.beginRecipientLink();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function deleteTelegramToken(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      await telegramSettings.clearBotToken();
      telegramNotifier?.setBotToken?.('');
      await settings.setUiSettings({ notifications: { telegram: { enabled: false } } });
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  async function postTelegramTokenTest(body: JsonBody): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      const input = asJsonBody(body);
      const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';
      const tokenToTest = botToken || telegramSettings.getBotToken();
      const identity = await telegramNotifier.getBotIdentity(tokenToTest);
      return Response.json({ success: true, bot: identity });
    } catch (error) {
      return telegramTokenTestFailedResponse(error);
    }
  }

  async function postTelegramRecipientLink(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      const linkUrl = await telegramSettings.beginRecipientLink();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, linkUrl, settings: snapshot });
    } catch (error) {
      return jsonErrorFromCorruptStateFile(error) ?? jsonErrorFromUnknown(error, 400);
    }
  }

  async function postTelegramRecipientResolve(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      const pendingLink = telegramSettings.getPendingRecipientLink();
      if (!pendingLink) {
        return jsonError('Telegram link expired or changed. Start a new link.', 409, 'telegram_link_changed', false);
      }
      const result = await telegramNotifier.resolveRecipientLink(
        pendingLink.linkCode,
        pendingLink.offset,
        TELEGRAM_LINK_POLL_SECONDS,
      );
      if (!await telegramSettings.applyRecipientLinkResult(pendingLink, result)) {
        return jsonError('Telegram link expired or changed. Start a new link.', 409, 'telegram_link_changed', false);
      }
      if (!result.recipient) {
        const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
        return Response.json({ success: false, error: 'No matching Telegram /start message found yet', settings: snapshot });
      }
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return jsonErrorFromCorruptStateFile(error) ?? jsonErrorFromUnknown(error, 400);
    }
  }

  async function deleteTelegramRecipient(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return jsonError('Telegram settings store is not configured', 500);
      }
      await telegramSettings.clearRecipient();
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return jsonErrorFromUnknown(error);
    }
  }

  return {
    '/api/v1/app/telegram/test': { POST: postTelegramTest },
    '/api/v1/app/telegram/token/test': { POST: withJsonBody(postTelegramTokenTest) },
    '/api/v1/app/telegram/token': { PUT: withJsonBody(putTelegramToken), DELETE: deleteTelegramToken },
    '/api/v1/app/telegram/recipient/link': { POST: postTelegramRecipientLink },
    '/api/v1/app/telegram/recipient/resolve': { POST: postTelegramRecipientResolve },
    '/api/v1/app/telegram/recipient': { DELETE: deleteTelegramRecipient },
  };
}
