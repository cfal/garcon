<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import { setLocalSettings } from '$lib/context';
	import { createLocalSettingsStore } from '$lib/stores/local-settings.svelte.js';
	import type { PullRequestDetail } from '$lib/api/pull-requests.js';
	import PullRequestChangesTab from '$lib/components/pr/PullRequestChangesTab.svelte';
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
	let pullRequest = $state.raw<PullRequestDetail | null>(null);
	let scrollRequest = $state<{ filePath: string; token: number } | null>(null);
	const review = new PullRequestDiffController();
	const settings = createLocalSettingsStore();
	setLocalSettings(settings);
	onDestroy(() => {
		review.close();
		settings.destroy();
	});
	const activeDocumentId = $derived(demandDriven ? (review.documentId ?? documentId) : documentId);
	const source = $derived(
		buildGitVirtualReviewRowSource({
			summary: {
				documentId: activeDocumentId,
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
		pullRequest = null;
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
		const plainReasons: string[] = [];
		for (const file of data.files) {
			const attempt = await highlightGitDiffFile(
				{ documentId, file, body: bodies[file.path] },
				new AbortController().signal,
			);
			if (attempt.status === 'highlighted') {
				results = { ...results, [file.path]: attempt.result };
				highlighted += 1;
			} else if (attempt.status === 'plain') plainReasons.push(attempt.reason);
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
			plainReasons,
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
		pullRequest = null;
		data = fixture(count, lines);
		demandDriven = true;
		mode = split ? 'split' : 'unified';
		documentId = `synthetic:${performance.now()}`;
		review.open({
			reviewId: documentId,
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
					reviewId: documentId,
					documentId: `${documentId}:metadata-refresh`,
					files: data.files,
					fileBodies: Object.fromEntries(data.bodies.map((body) => [body.path, body])),
				});
				await tick();
				return previous === review.fileBodies;
			},
			openPullRequest: async () => {
				review.close();
				const fixtureData = fixture(1, 12000);
				pullRequest = {
					reviewId: 'executor:repository:1',
					documentId: 'revision:1',
					number: 1,
					title: 'Synthetic change',
					body: '',
					state: 'open',
					isDraft: false,
					author: 'synthetic',
					headRefName: 'synthetic',
					baseRefName: 'main',
					headRefOid: 'a'.repeat(40),
					additions: 12000,
					deletions: 0,
					changedFiles: 1,
					createdAt: '2026-01-01',
					updatedAt: '2026-01-01',
					url: 'https://example.invalid/repository/pull/1',
					mergeable: 'mergeable',
					reviewDecision: null,
					checks: [],
					threads: [],
					files: fixtureData.files,
					fileBodies: Object.fromEntries(fixtureData.bodies.map((body) => [body.path, body])),
				};
				await tick();
			},
			refreshPullRequest: async () => {
				if (!pullRequest) throw new Error('No open pull request');
				pullRequest = {
					...structuredClone(pullRequest),
					documentId: `${pullRequest.documentId}:refresh`,
					updatedAt: '2026-01-02',
					title: 'Refreshed synthetic change',
				};
				await tick();
			},
			unicodeProbe: async () => {
				const input = fixture(1, 1);
				const text = 'const text = "\u4e2d\ud83d\ude80e\u0301";\r';
				input.bodies[0].patch = `@@ -0,0 +1 @@\n+${text}\n`;
				input.bodies[0].patchBytes = new TextEncoder().encode(input.bodies[0].patch).length;
				const body = await createIndexedGitReviewFileBody(input.bodies[0]);
				const attempt = await highlightGitDiffFile(
					{ documentId: 'synthetic:unicode', file: input.files[0], body },
					new AbortController().signal,
				);
				return {
					expected: text,
					indexed: body.patchIndex?.rowAt(1).text,
					highlighted:
						attempt.status === 'highlighted'
							? attempt.result.after?.lines
									.get(0)
									?.map((segment) => segment.text)
									.join('')
							: null,
				};
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
	{#if pullRequest}
		<PullRequestChangesTab detail={pullRequest} />
	{:else}
		<GitVirtualDiffViewport
			layoutIdentity={activeDocumentId}
			reviewDocumentId={activeDocumentId}
			{source}
			pinFileHeaders={false}
			fontSize={12}
			scrollToRequest={scrollRequest}
			onBodyDemand={(demand) => {
				if (demandDriven) review.handleDemand(demand);
			}}
			rowSnippet={renderRow}
		/>
	{/if}
</main>

{#snippet renderRow(row: GitVirtualReviewRow)}
	{#if row.kind === 'unified-row' || row.kind === 'split-row'}
		<GitVirtualDiffRow {row} fontSize={12} interaction={{ kind: 'read-only' }} />
	{:else}<div class="border-b border-border p-2">{row.filePath}</div>{/if}
{/snippet}
