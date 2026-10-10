import { isCleanCommandSuccess, type CommandOutcome } from '$shared/command-output.js';
import type { ChatDisplayRow } from './transcript-row-projection.js';

export function commandResultPresentation(result: CommandOutcome): 'hidden' | 'error' | 'warning' {
	if (result.outcome === 'failed') return 'error';
	if (isCleanCommandSuccess(result)) return 'hidden';
	return 'warning';
}

export function trailingDiagnosticNoticeDuplicate(
	rows: readonly ChatDisplayRow[],
): { noticeId: string; messageRowId: string } | null {
	const messageIndex = rows.findLastIndex(row => row.kind === 'message');
	const messageRow = rows[messageIndex];
	if (messageRow?.kind !== 'message') return null;
	if (messageRow.message.type === 'command-result') {
		if (isCleanCommandSuccess(messageRow.message.result)) return null;
	} else if (messageRow.message.type !== 'transcript-notice') return null;

	// Only the first trailing diagnostic can duplicate the final durable message.
	const notice = rows.slice(messageIndex + 1).find(row =>
		row.kind === 'local-notice' && (row.noticeType === 'error' || row.noticeType === 'warning'));
	if (notice?.kind !== 'local-notice') return null;
	if (notice.content !== messageRow.message.content) {
		const preceding = rows[messageIndex - 1];
		if (messageRow.message.type !== 'transcript-notice' || preceding?.kind !== 'message'
			|| preceding.message.type !== 'command-result' || preceding.message.result.outcome !== 'failed'
			|| notice.content !== `${preceding.message.content}\n${messageRow.message.content}`) return null;
	}
	return { noticeId: notice.id, messageRowId: messageRow.id };
}
