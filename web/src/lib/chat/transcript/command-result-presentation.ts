import { isCleanCommandSuccess, type CommandOutcome } from '$shared/command-output.js';
import type { ChatDisplayRow } from './transcript-row-projection.js';

export function commandResultPresentation(result: CommandOutcome): 'hidden' | 'error' | 'warning' {
	if (result.outcome === 'failed') return 'error';
	if (isCleanCommandSuccess(result)) return 'hidden';
	return 'warning';
}

export function commandResultNoticeDuplicate(
	rows: readonly ChatDisplayRow[],
): { noticeId: string; resultRowId: string } | null {
	const resultIndex = rows.findLastIndex(row => row.kind === 'message');
	const result = rows[resultIndex];
	if (result?.kind !== 'message' || result.message.type !== 'command-result'
		|| isCleanCommandSuccess(result.message.result)) return null;

	// Only the first trailing diagnostic can duplicate the final durable result.
	const notice = rows.slice(resultIndex + 1).find(row =>
		row.kind === 'local-notice' && (row.noticeType === 'error' || row.noticeType === 'warning'));
	if (notice?.kind !== 'local-notice' || notice.content !== result.message.content) return null;
	return { noticeId: notice.id, resultRowId: result.id };
}
