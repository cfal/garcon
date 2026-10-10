import type { CommandOutcome } from '$shared/command-output.js';
import type { ChatDisplayRow } from './transcript-row-projection.js';

export function commandResultPresentation(result: CommandOutcome): 'hidden' | 'error' | 'warning' {
	if (result.outcome === 'failed') return 'error';
	if (result.outcome === 'finished' && result.exitCode === 0 && result.signal === null
		&& result.capture === 'complete' && result.cwd.kind === 'reported') return 'hidden';
	return 'warning';
}

export function commandFailureNoticeDuplicate(
	rows: readonly ChatDisplayRow[],
): { noticeId: string; resultRowId: string } | null {
	const resultIndex = rows.findLastIndex(row => row.kind === 'message');
	const result = rows[resultIndex];
	if (result?.kind !== 'message' || result.message.type !== 'command-result'
		|| result.message.result.outcome !== 'failed') return null;

	// Only the first trailing error can duplicate the final durable failure.
	const notice = rows.slice(resultIndex + 1).find(row =>
		row.kind === 'local-notice' && row.noticeType === 'error');
	if (notice?.kind !== 'local-notice' || notice.content !== result.message.content) return null;
	return { noticeId: notice.id, resultRowId: result.id };
}
