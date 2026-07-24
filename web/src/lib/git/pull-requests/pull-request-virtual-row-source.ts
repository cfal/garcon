import type { PullRequestThread } from '$lib/api/pull-requests.js';
import type { GitReviewFileBody, GitReviewFileSummary } from '$lib/api/git.js';
import type {
	GitVirtualReviewRow,
	GitVirtualReviewThreadRow,
} from '$lib/git/review/git-virtual-review-document.svelte.js';
import type { GitVirtualReviewRowSource } from '$lib/git/review/git-virtual-review-row-source.js';

interface BaseRun {
	kind: 'base';
	start: number;
	count: number;
	baseStart: number;
}

interface ThreadRun {
	kind: 'threads';
	start: number;
	count: number;
	rows: GitVirtualReviewThreadRow[];
}

type DecoratedRun = BaseRun | ThreadRun;

interface ThreadInsertion {
	afterBaseIndex: number;
	rows: GitVirtualReviewThreadRow[];
}

interface ThreadInsertionGroup {
	anchored: PullRequestThread[];
	unanchored: PullRequestThread[];
}

interface PullRequestVirtualRowSourceOptions {
	baseSource: GitVirtualReviewRowSource;
	files: readonly GitReviewFileSummary[];
	fileBodies: Readonly<Record<string, GitReviewFileBody>>;
	threads: readonly PullRequestThread[];
	collapsedFilePaths: ReadonlySet<string>;
}

export function buildPullRequestVirtualRowSource(
	options: PullRequestVirtualRowSourceOptions,
): GitVirtualReviewRowSource {
	const insertions = buildThreadInsertions(options);
	if (insertions.length === 0) return options.baseSource;
	return new PullRequestVirtualRowSource(options.baseSource, options.files, insertions);
}

class PullRequestVirtualRowSource implements GitVirtualReviewRowSource {
	readonly rowCount: number;
	private readonly runs: DecoratedRun[];
	private readonly baseRuns: BaseRun[];
	private readonly fileStarts = new Map<string, number>();

	constructor(
		private readonly baseSource: GitVirtualReviewRowSource,
		files: readonly GitReviewFileSummary[],
		insertions: readonly ThreadInsertion[],
	) {
		this.runs = buildRuns(baseSource.rowCount, insertions);
		this.baseRuns = this.runs.filter((run): run is BaseRun => run.kind === 'base');
		this.rowCount = this.runs.reduce((total, run) => total + run.count, 0);
		for (const file of files) {
			const baseStart = baseSource.fileStart(file.path);
			if (baseStart === undefined) continue;
			const decoratedStart = this.decoratedIndexForBase(baseStart);
			if (decoratedStart !== undefined) this.fileStarts.set(file.path, decoratedStart);
		}
	}

	rowAt(index: number): GitVirtualReviewRow | null {
		const run = this.runAt(index);
		if (!run) return null;
		const localIndex = index - run.start;
		return run.kind === 'base'
			? this.baseSource.rowAt(run.baseStart + localIndex)
			: run.rows[localIndex] ?? null;
	}

	rowKey(index: number): string | number {
		const run = this.runAt(index);
		if (!run) return index;
		const localIndex = index - run.start;
		return run.kind === 'base'
			? this.baseSource.rowKey(run.baseStart + localIndex)
			: run.rows[localIndex]?.id ?? index;
	}

	estimateRowHeight(index: number, lineHeight: number): number {
		const run = this.runAt(index);
		if (!run) return lineHeight;
		const localIndex = index - run.start;
		return run.kind === 'base'
			? this.baseSource.estimateRowHeight(run.baseStart + localIndex, lineHeight)
			: run.rows[localIndex]?.estimatedHeight ?? lineHeight;
	}

	fileStart(filePath: string): number | undefined {
		return this.fileStarts.get(filePath);
	}

	fileState(filePath: string): 'pending' | 'resolved' | 'terminal' {
		return this.baseSource.fileState(filePath);
	}

	rowsInRange(start: number, end: number): GitVirtualReviewRow[] {
		const rows: GitVirtualReviewRow[] = [];
		const safeStart = Math.max(0, start);
		const safeEnd = Math.min(this.rowCount, end);
		for (let index = safeStart; index < safeEnd; index += 1) {
			const row = this.rowAt(index);
			if (row) rows.push(row);
		}
		return rows;
	}

	private decoratedIndexForBase(baseIndex: number): number | undefined {
		let low = 0;
		let high = this.baseRuns.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const run = this.baseRuns[middle];
			if (baseIndex < run.baseStart) high = middle - 1;
			else if (baseIndex >= run.baseStart + run.count) low = middle + 1;
			else return run.start + baseIndex - run.baseStart;
		}
		return undefined;
	}

	private runAt(index: number): DecoratedRun | null {
		let low = 0;
		let high = this.runs.length - 1;
		while (low <= high) {
			const middle = (low + high) >>> 1;
			const run = this.runs[middle];
			if (index < run.start) high = middle - 1;
			else if (index >= run.start + run.count) low = middle + 1;
			else return run;
		}
		return null;
	}
}

function buildThreadInsertions(
	options: PullRequestVirtualRowSourceOptions,
): ThreadInsertion[] {
	const fileOrder = new Map(options.files.map((file, index) => [file.path, index]));
	const threadsByFile = new Map<string, PullRequestThread[]>();
	for (const thread of options.threads) {
		if (options.collapsedFilePaths.has(thread.path) || !fileOrder.has(thread.path)) continue;
		const threads = threadsByFile.get(thread.path) ?? [];
		threads.push(thread);
		threadsByFile.set(thread.path, threads);
	}
	const grouped = new Map<number, ThreadInsertionGroup>();
	for (const [filePath, threads] of threadsByFile) {
		const fileIndex = fileOrder.get(filePath);
		const fileStart = options.baseSource.fileStart(filePath);
		if (fileIndex === undefined || fileStart === undefined) continue;
		const nextFile = options.files[fileIndex + 1];
		const nextFileStart = nextFile
			? options.baseSource.fileStart(nextFile.path)
			: options.baseSource.rowCount;
		const fileEnd = Math.max(fileStart, (nextFileStart ?? options.baseSource.rowCount) - 1);
		const targetIndexes = findThreadTargets(options.fileBodies[filePath], threads);
		for (const thread of threads) {
			const targetIndex = targetIndexes.get(thread.id) ?? null;
			const afterBaseIndex =
				targetIndex === null ? fileEnd : Math.min(fileEnd, fileStart + 1 + targetIndex);
			const group = grouped.get(afterBaseIndex) ?? { anchored: [], unanchored: [] };
			if (targetIndex === null) group.unanchored.push(thread);
			else group.anchored.push(thread);
			grouped.set(afterBaseIndex, group);
		}
	}
	return Array.from(grouped, ([afterBaseIndex, group]) => ({
		afterBaseIndex,
		rows: [
			...group.anchored.map((thread) => threadRow(thread, false)),
			...group.unanchored.map((thread, index) => threadRow(thread, index === 0)),
		],
	})).sort((left, right) => left.afterBaseIndex - right.afterBaseIndex);
}

function findThreadTargets(
	body: GitReviewFileBody | undefined,
	threads: readonly PullRequestThread[],
): Map<string, number> {
	const targets = new Map<string, number>();
	if (!body?.patchIndex) return targets;
	const threadIdsByLine = new Map<string, string[]>();
	for (const thread of threads) {
		if (thread.line <= 0) continue;
		const key = `${thread.side}:${thread.line}`;
		const ids = threadIdsByLine.get(key) ?? [];
		ids.push(thread.id);
		threadIdsByLine.set(key, ids);
	}
	for (let index = 0; index < body.patchIndex.rowCount; index += 1) {
		const row = body.patchIndex.rowAt(index);
		if (row.kind === 'hunk') continue;
		for (const [side, line] of [
			['before', row.beforeLine],
			['after', row.afterLine],
		] as const) {
			if (line === null) continue;
			const key = `${side}:${line}`;
			const ids = threadIdsByLine.get(key);
			if (!ids) continue;
			for (const id of ids) targets.set(id, index);
			threadIdsByLine.delete(key);
		}
		if (threadIdsByLine.size === 0) break;
	}
	return targets;
}

function threadRow(
	thread: PullRequestThread,
	showUnanchoredLabel: boolean,
): GitVirtualReviewThreadRow {
	const textLength = thread.comments.reduce((total, comment) => total + comment.body.length, 0);
	return {
		kind: 'review-thread',
		id: `pull-request-thread:${thread.id}`,
		filePath: thread.path,
		estimatedHeight:
			Math.min(480, 72 + thread.comments.length * 48 + Math.ceil(textLength / 80) * 18) +
			(showUnanchoredLabel ? 28 : 0),
		threadId: thread.id,
		showUnanchoredLabel,
	};
}

function buildRuns(
	baseRowCount: number,
	insertions: readonly ThreadInsertion[],
): DecoratedRun[] {
	const runs: DecoratedRun[] = [];
	let baseStart = 0;
	let start = 0;
	for (const insertion of insertions) {
		const baseEnd = Math.min(baseRowCount, Math.max(baseStart, insertion.afterBaseIndex + 1));
		if (baseEnd > baseStart) {
			const count = baseEnd - baseStart;
			runs.push({ kind: 'base', start, count, baseStart });
			start += count;
			baseStart = baseEnd;
		}
		runs.push({
			kind: 'threads',
			start,
			count: insertion.rows.length,
			rows: insertion.rows,
		});
		start += insertion.rows.length;
	}
	if (baseStart < baseRowCount) {
		runs.push({
			kind: 'base',
			start,
			count: baseRowCount - baseStart,
			baseStart,
		});
	}
	return runs;
}
