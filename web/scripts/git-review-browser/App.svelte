<script lang="ts">
	import { tick } from 'svelte';
	import {
		DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
		type GitReviewFileBody,
	} from '../../src/lib/api/git.js';
	import { createIndexedGitReviewFileBody } from '$review-compute/git-review-body-index.js';
	import { highlightGitDiffFile } from '$review-highlight';
	import { buildGitVirtualReviewRowSource } from '../../src/lib/git/review/git-virtual-review-row-source.js';
	import type { GitDiffSyntaxResults } from '../../src/lib/git/review/git-diff-syntax.js';
	import type { GitVirtualReviewRow } from '../../src/lib/git/review/git-virtual-review-document.svelte.js';
	import GitVirtualDiffViewport from '../../src/lib/components/git/GitVirtualDiffViewport.svelte';
	import GitVirtualDiffRow from '../../src/lib/components/git/GitVirtualDiffRow.svelte';
	import { fixture } from './fixtures.js';
	import { PullRequestDiffController } from '../../src/lib/git/pull-requests/pull-request-diff.svelte.js';

	let data = $state.raw(fixture(1, 1));
	let bodies = $state.raw<Record<string, GitReviewFileBody>>({});
	let results = $state.raw<GitDiffSyntaxResults>({});
	let mode = $state<'unified' | 'split'>('unified');
	let documentId = $state('synthetic:0');
	let demandDriven = $state(false);
	let scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	const review = new PullRequestDiffController();
	const source = $derived(
		buildGitVirtualReviewRowSource({
			summary: {
				documentId,
				project: '',
				context: 3,
				files: data.files,
				limits: DEFAULT_GIT_REVIEW_DOCUMENT_LIMITS,
			},
			visibleFilePaths: data.files.map((file) => file.path),
			fileBodies: demandDriven ? review.fileBodies : bodies,
			syntaxResults: demandDriven ? review.syntax.results : results,
			loadingBodies: demandDriven ? review.loadingBodies : new Set(),
			focusedFilePath: null,
			diffMode: mode,
			contextLines: 3,
			interaction: { kind: 'read-only' },
		}),
	);

	async function run(count: number, lines: number, split = false, lineLength = 0) {
		demandDriven = false;
		review.close();
		data = fixture(count, lines, lineLength);
		bodies = {};
		results = {};
		mode = split ? 'split' : 'unified';
		documentId = `synthetic:${performance.now()}`;
		await tick();
		await new Promise(requestAnimationFrame);
		const longTasks: number[] = [];
		const observer = new PerformanceObserver((list) =>
			longTasks.push(...list.getEntries().map((e) => e.duration)),
		);
		observer.observe({ type: 'longtask', buffered: false });
		let last = performance.now();
		let maxGap = 0;
		const heartbeat = setInterval(() => {
			const now = performance.now();
			maxGap = Math.max(maxGap, now - last);
			last = now;
		}, 10);
		const started = performance.now();
		performance.clearMeasures();
		const indexed: Record<string, GitReviewFileBody> = {};
		for (const body of data.bodies) indexed[body.path] = await createIndexedGitReviewFileBody(body);
		bodies = indexed;
		await tick();
		await new Promise(requestAnimationFrame);
		const firstRowMs = performance.now() - started;
		const before = document.querySelector('[data-git-diff-review-row]')?.getBoundingClientRect();
		let highlighted = 0;
		for (const file of data.files) {
			const attempt = await highlightGitDiffFile(
				{ documentId, file, body: bodies[file.path] },
				new AbortController().signal,
			);
			if (attempt.status === 'highlighted') {
				results = { ...results, [file.path]: attempt.result };
				highlighted += 1;
			}
		}
		await tick();
		await new Promise(requestAnimationFrame);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const after = document.querySelector('[data-git-diff-review-row]')?.getBoundingClientRect();
		clearInterval(heartbeat);
		observer.disconnect();
		return {
			count,
			lines,
			split,
			lineLength,
			firstRowMs,
			totalMs: performance.now() - started,
			highlighted,
			maxHeartbeatGapMs: maxGap,
			longTasks,
			rowHeightBefore: before?.height,
			rowHeightAfter: after?.height,
			renderedRows: document.querySelectorAll('[data-git-diff-content-row]').length,
			phases: performance
				.getEntriesByType('measure')
				.map((entry) => ({ name: entry.name, duration: entry.duration })),
		};
	}
	async function openReview(count: number, lines: number, split = false) {
		data = fixture(count, lines);
		demandDriven = true;
		mode = split ? 'split' : 'unified';
		documentId = `synthetic:${performance.now()}`;
		review.open({
			documentId,
			files: data.files,
			fileBodies: Object.fromEntries(data.bodies.map((body) => [body.path, body])),
		});
		await tick();
		return documentId;
	}
	async function cancelProbe() {
		const input = fixture(1, 12000);
		const body = await createIndexedGitReviewFileBody(input.bodies[0]);
		const abort = new AbortController();
		const pending = highlightGitDiffFile(
			{ documentId: 'synthetic:cancel', file: input.files[0], body },
			abort.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const started = performance.now();
		abort.abort();
		const result = await pending;
		return { status: result.status, cancellationMs: performance.now() - started };
	}
	Object.assign(window, {
		reviewBenchmark: {
			run,
			openReview,
			refreshReview: async () => {
				const previous = review.fileBodies;
				data = structuredClone(data);
				review.open({
					documentId,
					files: data.files,
					fileBodies: Object.fromEntries(data.bodies.map((body) => [body.path, body])),
				});
				await tick();
				return previous === review.fileBodies;
			},
			cancelProbe,
			inspect: () => ({
				documentId,
				loaded: Object.keys(review.fileBodies),
				highlighted: Object.keys(review.syntax.results),
				pending: [...review.loadingBodies],
			}),
			navigate: (filePath: string) => {
				scrollRequest = { filePath, token: performance.now() };
			},
			clearColors: async () => {
				results = {};
				await tick();
			},
			color: async () => {
				const file = data.files[0];
				const attempt = await highlightGitDiffFile(
					{ documentId, file, body: bodies[file.path] },
					new AbortController().signal,
				);
				if (attempt.status === 'highlighted') results = { [file.path]: attempt.result };
				await tick();
				return attempt.status;
			},
		},
	});
</script>

<main class="flex h-screen flex-col bg-background text-foreground">
	<label class="border-b border-border p-2"
		>Synthetic review <input
			aria-label="Typing probe"
			class="border border-border bg-background"
		/></label
	>
	<GitVirtualDiffViewport
		layoutIdentity={documentId}
		reviewDocumentId={documentId}
		{source}
		pinFileHeaders={false}
		fontSize={12}
		scrollToRequest={scrollRequest}
		onBodyDemand={(demand) => {
			if (demandDriven) review.handleDemand(demand);
		}}
		rowSnippet={renderRow}
	/>
</main>

{#snippet renderRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'unified-row' || row.kind === 'split-row'}
		<GitVirtualDiffRow {row} fontSize={12} interaction={{ kind: 'read-only' }} />
	{:else}<div class="border-b border-border p-2">{row.filePath}</div>{/if}
{/snippet}
