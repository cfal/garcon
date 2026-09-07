import {
  canonicalTranscriptExportCategories,
  isTranscriptExportCategory,
  isTranscriptExportFormat,
  type TranscriptExportCategory,
} from '../../common/chat-export-contracts.js';
import { parseChatId } from '../../common/chat-id.js';
import type { TranscriptExportService } from '../chats/transcript-export/service.js';
import { ValidationDomainError } from '../lib/domain-error.js';
import { jsonErrorFromUnknown } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import {
  noStore,
  normalizeChatIdError,
  requiredSingleParameter,
} from './chat-read-helpers.js';

export function createChatExportRoutes(service: TranscriptExportService): RouteMap {
  async function getExport(request: Request, url: URL): Promise<Response> {
    try {
      const chatId = requiredSingleParameter(url.searchParams, 'chatId');
      const rawFormats = url.searchParams.getAll('format');
      if (rawFormats.length > 1) {
        throw new ValidationDomainError('format query parameter must be provided at most once');
      }
      const format = rawFormats[0] ?? 'markdown';
      if (!isTranscriptExportFormat(format)) {
        throw new ValidationDomainError('format must be markdown or xml');
      }
      const exclusions = parseExclusions(url.searchParams.getAll('exclude'));
      return noStore(Response.json(await service.export({
        chatId: parseChatId(chatId),
        format,
        exclusions,
      }, request.signal)));
    } catch (error) {
      return noStore(jsonErrorFromUnknown(normalizeChatIdError(error)));
    }
  }

  return {
    '/api/v1/chats/export': { GET: getExport },
  };
}

function parseExclusions(values: readonly string[]): TranscriptExportCategory[] {
  const categories: TranscriptExportCategory[] = [];
  for (const value of values) {
    if (!isTranscriptExportCategory(value)) {
      throw new ValidationDomainError(
        'exclude must be one of: tool-calls, tool-results, reasoning, permissions, diagnostics, handoffs',
      );
    }
    categories.push(value);
  }
  return canonicalTranscriptExportCategories(categories);
}
