import { jsonErrorFromUnknown } from '../../common/http-error.js';
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
  return Response.json({
    success: false,
    error: 'Telegram token test failed',
    errorCode: 'telegram_token_test_failed',
    details: error instanceof Error ? error.message : String(error),
  }, { status: 400 });
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
        return Response.json({ success: false, error: 'Telegram bot token is not configured' }, { status: 400 });
      }
      const chatId = telegramSettings?.getRecipientChatId?.() ?? '';
      if (!chatId) {
        return Response.json({ success: false, error: 'Telegram recipient is not linked' }, { status: 400 });
      }
      const ok = await telegramNotifier.send(chatId, 'Garcon: test notification. Your Telegram integration is working.');
      if (!ok) {
        return Response.json({ success: false, error: 'Telegram delivery failed. Check your bot token and linked recipient.' }, { status: 502 });
      }
      return Response.json({ success: true });
    } catch (error) {
      const message = errorMessage(error);
      const status = message.startsWith('Telegram ') || message.includes('bot token') ? 400 : 500;
      return Response.json({ success: false, error: message }, { status });
    }
  }

  async function putTelegramToken(body: JsonBody): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const input = asJsonBody(body);
      const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';
      if (!botToken) {
        return Response.json({
          success: false,
          error: 'botToken is required',
          errorCode: 'telegram_bot_token_required',
        }, { status: 400 });
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
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
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
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
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
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
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
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
      }
      const linkCode = telegramSettings.getPendingLinkCode();
      const offset = telegramSettings.getUpdateOffset();
      const result = await telegramNotifier.resolveRecipientLink(
        linkCode,
        offset,
        TELEGRAM_LINK_POLL_SECONDS,
      );
      if (result.nextOffset !== offset) {
        await telegramSettings.setUpdateOffset(result.nextOffset);
      }
      if (!result.recipient) {
        const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
        return Response.json({ success: false, error: 'No matching Telegram /start message found yet', settings: snapshot });
      }
      await telegramSettings.completeRecipientLink(result.recipient);
      const snapshot = await buildRemoteSettingsSnapshot({ settings, agents, telegramSettings, projectBasePath });
      return Response.json({ success: true, settings: snapshot });
    } catch (error) {
      return jsonErrorFromCorruptStateFile(error) ?? jsonErrorFromUnknown(error, 400);
    }
  }

  async function deleteTelegramRecipient(): Promise<Response> {
    try {
      if (!telegramSettings) {
        return Response.json({ success: false, error: 'Telegram settings store is not configured' }, { status: 500 });
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
