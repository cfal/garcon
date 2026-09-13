import { parseHttpTicketMutationRequest, parseMarkupTicketMutationPayload,
  type MarkupTicketMutationPayload } from '@garcon/common/ticket-commands';
import { ticketBytes } from '@garcon/common/ticket-validation';
import { TICKET_LIMITS } from '@garcon/common/tickets';
import { isTicketRead, type TicketCliCommand } from './ticket-args.js';
import { argumentError, CliError } from './errors.js';
import { GarconHttpError, type GarconClient } from './garcon-client.js';
import { formatTicketDetail, formatTicketHistory, formatTicketList, formatTicketMutation,
  ticketJsonOutput, ticketRetryDiagnostic } from './ticket-output.js';
import { validateTicketStdin } from './ticket-stdin.js';
import type { CliOutput } from './output.js';

export type TicketClient = Pick<GarconClient, 'getTicketBootstrap' | 'getTicketProjectDefault'
  | 'listTickets' | 'readTicket' | 'getTicketHistory' | 'mutateTicket'>;

export function applyTicketStdin(command: TicketCliCommand, text: string): TicketCliCommand {
  const body = validateTicketStdin(text);
  const operation = command.operation;
  let payload: MarkupTicketMutationPayload;
  switch (operation.action) {
    case 'create': payload = { ...operation, input: { ...operation.input, description: body } }; break;
    case 'comment': case 'comment-edit': payload = { ...operation, body }; break;
    case 'close': payload = { ...operation, comment: body }; break;
    default: throw argumentError('This ticket command does not accept stdin');
  }
  try { return { ...command, operation: parseMarkupTicketMutationPayload(payload), readsBodyFromStdin: false }; }
  catch (error) { throw argumentError(error instanceof Error ? error.message : 'Invalid stdin', { cause: error }); }
}

export async function runTicketCommand(command: TicketCliCommand, client: TicketClient,
  output: CliOutput, signal?: AbortSignal, onSubmissionStarted?: () => void): Promise<void> {
  if (command.readsBodyFromStdin) throw argumentError('Ticket stdin has not been read');
  const operation = command.operation;
  if (isTicketRead(operation)) {
    switch (operation.action) {
      case 'list': {
        const page = await client.listTickets(operation.query, signal);
        output.result(command.json ? ticketJsonOutput(page) : formatTicketList(page)); return;
      }
      case 'read': {
        const detail = await client.readTicket(operation.query, signal);
        output.result(command.json ? ticketJsonOutput(detail) : formatTicketDetail(detail)); return;
      }
      case 'history': {
        const page = await client.getTicketHistory(operation.query, signal);
        output.result(command.json ? ticketJsonOutput(page) : formatTicketHistory(page)); return;
      }
    }
  }
  const identity = command.retry ?? { requestId: crypto.randomUUID(),
    expectedStoreId: (await client.getTicketBootstrap(signal)).storeId };
  let payload = operation;
  let kind: 'repository' | 'folder' | 'explicit' = 'explicit';
  if (payload.action === 'create' && payload.input.project === undefined) {
    if (!command.cwd || command.retry) throw argumentError('A new create needs a directory or an explicit project');
    const resolved = await client.getTicketProjectDefault(command.cwd, signal);
    payload = { ...payload, input: { ...payload.input, project: resolved.project } };
    kind = resolved.kind;
  }
  const request = parseHttpTicketMutationRequest({ ...identity, payload,
    ...(command.fromChatId ? { fromChatId: command.fromChatId } : {}) });
  if (ticketBytes(JSON.stringify(request)) > TICKET_LIMITS.requestBytes) {
    throw argumentError('Encoded ticket request exceeds 64 KiB; reduce the submitted body');
  }
  output.diagnostic(ticketRetryDiagnostic(request, kind));
  signal?.throwIfAborted();
  onSubmissionStarted?.();
  try {
    const result = await client.mutateTicket(request, signal);
    output.result(command.json ? ticketJsonOutput(result) : formatTicketMutation(result));
  } catch (error) {
    if (error instanceof GarconHttpError) throw error;
    throw new CliError('tickets', 'Save not confirmed. Inspect the ticket or retry the same request with the printed identity and identical body.', 3, { cause: error });
  }
}
