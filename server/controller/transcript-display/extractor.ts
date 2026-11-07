import { isToolUseMessage, type ChatMessage } from '../../../common/chat-types.js';
import { hasEmptyRequiredInput, intrinsicDisplayRole, toolHideGroup, toolResultVisible, toolSummaryCategory,
  toolSummaryWeight, type DisplayRole, type ToolType } from '../../../common/transcript-display-policy.js';
import { isCleanCommandSuccess } from '../../../common/command-output.js';
import { decodeStoredLedgerRow, type StoredLedgerRow } from '../ledger/codec.js';
import { ledgerRowToMessage } from '../ledger/presentation.js';
import type { LedgerRow } from '../ledger/contracts.js';
import { classId } from './classes.js';
import { DisplayStore, contentDigest, sourceFingerprint } from './store.js';
import { appendSubagentFact } from './subagents.js';

interface PendingUse { use_ordinal: number; tool_type: ToolType; empty_required_input: number; wrapper_ordinal: number | null }
interface CommandEvidence {
  first_output_ordinal: number | null; stdout_count: number; result_count: number;
  last_result_ordinal: number | null; last_result_complete: number; last_gap_at_result: number;
}
interface Tail { ordinal: number; failed_result: number }

export function appendDisplayFrame(store: DisplayStore, rows: readonly StoredLedgerRow[], goal: number,
  serverInstanceId: string, previousTail?: StoredLedgerRow): number {
  const manifest = store.manifest();
  if (!manifest) throw new Error('Display store is not initialized');
  if (!rows.length) return manifest.prepared_through;
  if (rows[0].ordinal !== manifest.prepared_through + 1) throw new Error('Display frame is not contiguous');
  let ordinal = manifest.prepared_through;
  let gap = manifest.last_gap_ordinal;
  let previous = previousTail ? ledgerRowToMessage(decodeStoredLedgerRow(previousTail)) : null;
  const requiredTail = store.get<Tail>('SELECT ordinal, failed_result FROM public_tail ORDER BY ordinal DESC LIMIT 1');
  if (requiredTail?.failed_result && previousTail?.ordinal !== requiredTail.ordinal) throw new Error('Missing public tail dependency');
  return store.db.transaction(() => {
    for (const stored of rows) {
      if (stored.view_id !== manifest.view_id || stored.ordinal !== ++ordinal || ordinal > goal) throw new Error('Invalid display frame identity');
      const row = decodeStoredLedgerRow(stored);
      const message = ledgerRowToMessage(row);
      if (message?.type === 'transcript-notice' && message.detail?.type === 'publication-gap') gap = ordinal;
      appendFeature(store, row, message, stored.payload_json.length * 2);
      if (message?.type === 'command-output' || message?.type === 'command-result') appendCommandEvidence(store, ordinal, message, gap);
      appendUserNavigation(store, ordinal, message);
      appendSubagentFact(store, ordinal, message);
      if (message) {
        const content = 'content' in message && typeof message.content === 'string' ? message.content : null;
        const diagnostic = message.type === 'transcript-notice' || (message.type === 'command-result' && !isCleanCommandSuccess(message.result));
        const combined = message.type === 'transcript-notice' && previous?.type === 'command-result'
          && previous.result.outcome === 'failed' ? contentDigest(`${previous.content}\n${message.content}`) : null;
        store.run('INSERT INTO public_tail VALUES (?, ?, ?, ?, ?)', ordinal, message.type,
          diagnostic && content !== null ? contentDigest(content) : null, combined,
          Number(message.type === 'command-result' && message.result.outcome === 'failed'));
        previous = message;
      }
    }
    store.run('UPDATE manifest SET prepared_through = ?, frontier_fingerprint = ?, last_gap_ordinal = ?, captured_goal = ?, written_by_server_instance = ? WHERE singleton = 1',
      ordinal, sourceFingerprint(rows.at(-1)!), gap, goal, serverInstanceId);
    return ordinal;
  })();
}

function appendFeature(store: DisplayStore, row: LedgerRow, message: ChatMessage | null, bytes: number): void {
  const ordinal = row.ordinal;
  let role: DisplayRole = message && message.type !== 'tool-result' ? intrinsicDisplayRole(message) : 'hidden';
  let paired: PendingUse | null = null;
  if (message?.type === 'permission-request' && message.requestedTool.type === 'ask-user-question-tool-use') {
    const toolId = message.requestedTool.toolId;
    const use = store.get<{ use_ordinal: number }>('SELECT use_ordinal FROM pending_use INDEXED BY pending_unwrapped_question WHERE tool_id = ? AND is_question = 1 AND wrapper_ordinal IS NULL ORDER BY use_ordinal LIMIT 1', toolId);
    if (use) store.run('UPDATE pending_use SET wrapper_ordinal = ? WHERE tool_id = ? AND use_ordinal = ?', ordinal, toolId, use.use_ordinal);
    else store.run('INSERT INTO pending_wrapper VALUES (?, ?)', toolId, ordinal);
  } else if (message && isToolUseMessage(message)) {
    const question = message.type === 'ask-user-question-tool-use';
    const wrapper = question ? store.get<{ wrapper_ordinal: number }>('SELECT wrapper_ordinal FROM pending_wrapper WHERE tool_id = ? ORDER BY wrapper_ordinal LIMIT 1', message.toolId) : null;
    store.run('INSERT INTO pending_use VALUES (?, ?, ?, ?, ?, ?)', message.toolId, ordinal, message.type,
      Number(hasEmptyRequiredInput(message)), Number(question), wrapper?.wrapper_ordinal ?? null);
    if (wrapper) store.run('DELETE FROM pending_wrapper WHERE tool_id = ? AND wrapper_ordinal = ?', message.toolId, wrapper.wrapper_ordinal);
    if (message.type === 'bash-tool-use') store.run('INSERT INTO bash_input VALUES (?, ?)', ordinal, message.command);
  } else if (message?.type === 'tool-result') {
    paired = store.get<PendingUse>('SELECT use_ordinal, tool_type, empty_required_input, wrapper_ordinal FROM pending_use WHERE tool_id = ? ORDER BY use_ordinal LIMIT 1', message.toolId);
    if (paired) {
      store.run('DELETE FROM pending_use WHERE tool_id = ? AND use_ordinal = ?', message.toolId, paired.use_ordinal);
      store.run('INSERT INTO tool_pair VALUES (?, ?, ?, ?)', paired.use_ordinal, ordinal, paired.wrapper_ordinal, ordinal);
      const visible = paired.tool_type === 'ask-user-question-tool-use' ? paired.wrapper_ordinal === null
        : toolResultVisible(paired.tool_type, message.isError === true, paired.empty_required_input === 1);
      if (visible) role = 'breaker';
    }
  }
  if (message?.type === 'permission-resolved' || message?.type === 'permission-cancelled' || message?.type === 'permission-expired') {
    store.run('INSERT INTO permission_terminal VALUES (?, ?)', message.permissionOccurrenceId, ordinal);
  }
  const tool = message && isToolUseMessage(message) ? message : null;
  const type = tool?.type ?? paired?.tool_type;
  let id: number | null = null;
  if (role !== 'hidden') {
    id = classId({
      role,
      group: type ? toolHideGroup(type) : null,
      category: role === 'member' && tool ? toolSummaryCategory(tool.type) : null,
      thinking: message?.type === 'thinking',
      bash: type === 'bash-tool-use',
    });
  }
  store.run('INSERT INTO feature VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ordinal, role, id, message?.type ?? null,
    message && 'permissionOccurrenceId' in message ? message.permissionOccurrenceId : null,
    message && 'commandId' in message ? message.commandId : null,
    Number(message?.type === 'command-output' && message.channel === 'stdout' && message.offset === 0 && message.format === 'markdown'),
    bytes, row.kind === 'user-input' ? row.detail.clientMessageId : null);
  if (id === null) return;
  const weight = role === 'member' && tool ? toolSummaryWeight(tool) : 0;
  appendPosting(store, id, ordinal, weight);
  if (type === 'bash-tool-use') store.run('INSERT INTO bash_event VALUES (?, ?, ?, ?)', ordinal, paired?.use_ordinal ?? ordinal, id, weight);
}

function appendPosting(store: DisplayStore, id: number, ordinal: number, weight: number): void {
  const last = store.get<{ rank: number; cumulative_weight: number }>('SELECT rank, cumulative_weight FROM class_tail WHERE class_id = ?', id);
  const rank = (last?.rank ?? 0) + 1, cumulative = (last?.cumulative_weight ?? 0) + weight;
  if (!Number.isSafeInteger(cumulative)) throw new Error('Display aggregate overflow');
  store.run('INSERT INTO posting VALUES (?, ?, ?, ?)', id, ordinal, rank, cumulative);
  store.run('INSERT INTO class_tail VALUES (?, ?, ?) ON CONFLICT(class_id) DO UPDATE SET rank = excluded.rank, cumulative_weight = excluded.cumulative_weight', id, rank, cumulative);
}

function appendCommandEvidence(store: DisplayStore, ordinal: number,
  message: Extract<ChatMessage, { type: 'command-output' | 'command-result' }>, gap: number): void {
  const previous = store.get<CommandEvidence>('SELECT * FROM command_evidence WHERE command_id = ? ORDER BY evidence_ordinal DESC LIMIT 1', message.commandId)
    ?? { first_output_ordinal: null, stdout_count: 0, result_count: 0, last_result_ordinal: null, last_result_complete: 0, last_gap_at_result: 0 };
  if (message.type === 'command-output') {
    previous.first_output_ordinal ??= ordinal;
    if (message.channel === 'stdout') previous.stdout_count++;
  } else {
    previous.result_count++;
    previous.last_result_ordinal = ordinal;
    previous.last_result_complete = Number(message.result.capture === 'complete');
    previous.last_gap_at_result = gap;
  }
  store.run('INSERT INTO command_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?)', message.commandId, ordinal,
    previous.first_output_ordinal, previous.stdout_count, previous.result_count, previous.last_result_ordinal,
    previous.last_result_complete, previous.last_gap_at_result);
}

function appendUserNavigation(store: DisplayStore, ordinal: number, message: ChatMessage | null): void {
  if (message?.type !== 'user-message') return;
  store.run('INSERT INTO user_navigation VALUES (?, ?, ?, ?, ?, ?)', ordinal,
    message.content.slice(0, 300), message.timestamp, Number(message.content.trim().length > 0), message.images?.length ?? 0,
    message.presentation ? JSON.stringify(message.presentation) : null);
}
