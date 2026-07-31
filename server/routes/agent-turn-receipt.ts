import type { CommandLedger } from '../commands/command-ledger.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import { jsonError } from '../lib/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';

export function createAgentTurnReceiptRoutes(ledger: CommandLedger): RouteMap {
  return {
    '/api/v1/chats/turn-receipt': {
      GET: async (_request, url) => {
        const chatId = url.searchParams.get('chatId')?.trim() ?? '';
        const turnId = url.searchParams.get('turnId')?.trim() ?? '';
        if (!chatId || !turnId) {
          return noStore(jsonError('chatId and turnId are required', 400, 'VALIDATION_FAILED', false));
        }
        const record = await ledger.getTurnRecord(chatId, turnId);
        if (!record) {
          return noStore(jsonError(
            'Turn receipt not found',
            404,
            'TURN_RECEIPT_NOT_FOUND',
            false,
          ));
        }
        const projected = projectAgentTurnReceipt(record);
        if (projected.kind === 'expired') {
          return noStore(jsonError(
            'Turn result expired',
            410,
            'TURN_RESULT_EXPIRED',
            false,
          ));
        }
        return noStore(Response.json(projected.receipt));
      },
    },
  };
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
