import type { CommandLedger } from '../commands/command-ledger.js';
import { projectAgentTurnReceipt } from '../commands/agent-turn-receipt-projector.js';
import { jsonError } from '../../common/http-error.js';
import type { RouteMap } from '../lib/http-route-types.js';
import type { AgentTurnReceipt } from '../../../common/agent-turn-receipt.js';
import { CLI_ENVELOPE_BYTES, cliReplyBytes } from '../../remote/transport/cli-protocol.js';

export function createAgentTurnReceiptRoutes(ledger: CommandLedger): RouteMap {
  return {
    '/api/v1/chats/turn-receipt': {
      GET: async (_request, url, _server, context) => {
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
        const receipt = context?.principal?.mode === 'executor'
          ? fitForwardedOutput(projected.receipt) : projected.receipt;
        return noStore(Response.json(receipt));
      },
    },
  };
}

function fitForwardedOutput(receipt: AgentTurnReceipt): AgentTurnReceipt {
  if (receipt.state !== 'completed' || receipt.output.availability !== 'available') return receipt;
  const byteLimit = cliReplyBytes('primary');
  const fits = (candidate: AgentTurnReceipt) => (
    Buffer.byteLength(JSON.stringify({ status: 200, body: candidate })) + CLI_ENVELOPE_BYTES <= byteLimit
  );
  if (fits(receipt)) return receipt;

  const text = receipt.output.text;
  const notice = '[CLI output truncated; full retained output is in the transcript]\n';
  const output = { ...receipt.output, completeness: 'best-effort' as const, text: notice };
  const forwardedReceipt = { ...receipt, output };
  // Bounds fitting work even when another integration returns a multi-megabyte response.
  let low = Math.max(0, text.length - byteLimit);
  let high = text.length;
  const tail = (start: number) => {
    if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '')) start++;
    return notice + text.slice(start);
  };
  while (low < high) {
    const start = Math.floor((low + high) / 2);
    output.text = tail(start);
    if (fits(forwardedReceipt)) high = start;
    else low = start + 1;
  }
  output.text = tail(low);
  return forwardedReceipt;
}

function noStore(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  return response;
}
