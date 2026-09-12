import { parseHttpIssueMutationRequest, parseMarkupIssueMutationPayload,
  type MarkupIssueMutationPayload } from '@garcon/common/issue-commands';
import { issueBytes } from '@garcon/common/issue-validation';
import { ISSUE_LIMITS } from '@garcon/common/issues';
import { isIssueRead, type IssueCliCommand } from './issue-args.js';
import { argumentError, CliError } from './errors.js';
import { GarconHttpError, type GarconClient } from './garcon-client.js';
import { formatIssueDetail, formatIssueHistory, formatIssueList, formatIssueMutation,
  issueJsonOutput, issueRetryDiagnostic } from './issue-output.js';
import { validateIssueStdin } from './issue-stdin.js';
import type { CliOutput } from './output.js';

export type IssueClient = Pick<GarconClient, 'getIssueBootstrap' | 'getIssueProjectDefault'
  | 'listIssues' | 'readIssue' | 'getIssueHistory' | 'mutateIssue'>;

export function applyIssueStdin(command: IssueCliCommand, text: string): IssueCliCommand {
  const body = validateIssueStdin(text);
  const operation = command.operation;
  let payload: MarkupIssueMutationPayload;
  switch (operation.action) {
    case 'create': payload = { ...operation, input: { ...operation.input, description: body } }; break;
    case 'comment': case 'comment-edit': payload = { ...operation, body }; break;
    case 'close': payload = { ...operation, comment: body }; break;
    default: throw argumentError('This issue command does not accept stdin');
  }
  try { return { ...command, operation: parseMarkupIssueMutationPayload(payload), readsBodyFromStdin: false }; }
  catch (error) { throw argumentError(error instanceof Error ? error.message : 'Invalid stdin', { cause: error }); }
}

export async function runIssueCommand(command: IssueCliCommand, client: IssueClient,
  output: CliOutput, signal?: AbortSignal, onSubmissionStarted?: () => void): Promise<void> {
  if (command.readsBodyFromStdin) throw argumentError('Issue stdin has not been read');
  const operation = command.operation;
  if (isIssueRead(operation)) {
    switch (operation.action) {
      case 'list': {
        const page = await client.listIssues(operation.query, signal);
        output.result(command.json ? issueJsonOutput(page) : formatIssueList(page)); return;
      }
      case 'read': {
        const detail = await client.readIssue(operation.query, signal);
        output.result(command.json ? issueJsonOutput(detail) : formatIssueDetail(detail)); return;
      }
      case 'history': {
        const page = await client.getIssueHistory(operation.query, signal);
        output.result(command.json ? issueJsonOutput(page) : formatIssueHistory(page)); return;
      }
    }
  }
  const identity = command.retry ?? { requestId: crypto.randomUUID(),
    expectedStoreId: (await client.getIssueBootstrap(signal)).storeId };
  let payload = operation;
  let kind: 'repository' | 'folder' | 'explicit' = 'explicit';
  if (payload.action === 'create' && payload.input.project === undefined) {
    if (!command.cwd || command.retry) throw argumentError('A new create needs a directory or an explicit project');
    const resolved = await client.getIssueProjectDefault(command.cwd, signal);
    payload = { ...payload, input: { ...payload.input, project: resolved.project } };
    kind = resolved.kind;
  }
  const request = parseHttpIssueMutationRequest({ ...identity, payload,
    ...(command.fromChatId ? { fromChatId: command.fromChatId } : {}) });
  if (issueBytes(JSON.stringify(request)) > ISSUE_LIMITS.requestBytes) {
    throw argumentError('Encoded issue request exceeds 64 KiB; reduce the submitted body');
  }
  output.diagnostic(issueRetryDiagnostic(request, kind));
  signal?.throwIfAborted();
  onSubmissionStarted?.();
  try {
    const result = await client.mutateIssue(request, signal);
    output.result(command.json ? issueJsonOutput(result) : formatIssueMutation(result));
  } catch (error) {
    if (error instanceof GarconHttpError) throw error;
    throw new CliError('issues', 'Save not confirmed. Inspect the issue or retry the same request with the printed identity and identical body.', 3, { cause: error });
  }
}
