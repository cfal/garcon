<script lang="ts">
	import SnippetsSection from '../SnippetsSection.svelte';
	import { ApiError } from '$lib/api/client.js';
	import { setNotifications, setSnippets, setTransientLayers } from '$lib/context';
	import { createSnippetsStore } from '$lib/snippets/snippets-store.svelte.js';
	import { createNotificationsStore } from '$lib/stores/notifications.svelte.js';
	import { WorkspaceInteractionGate } from '$lib/workspace/workspace-interaction-gate.svelte.js';
	import { TransientLayerRegistry } from '$lib/workspace/transient-layers.svelte.js';
	import {
		SNIPPET_ERROR_CODES,
		sortSnippetsByShortName,
		type Snippet,
		type SnippetsSnapshot,
	} from '$shared/snippets';

	interface Props {
		blockRefresh?: boolean;
		blockSave?: boolean;
		showSection?: boolean;
	}

	let { blockRefresh = false, blockSave = false, showSection = true }: Props = $props();

	function entry(id: string, shortName: string, template: string, defaultArguments = ''): Snippet {
		return {
			id,
			shortName,
			template,
			defaultArguments,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		};
	}

	let current: SnippetsSnapshot = {
		revision: 1,
		snippets: sortSnippetsByShortName([
			entry('two', 'summarize', 'Summarize this'),
			entry('one', 'review', 'Review this'),
		]),
	};
	let loadCount = 0;
	let releaseRefresh: (() => void) | null = null;
	let holdNextGet = false;
	let releaseHeldGet: (() => void) | null = null;
	let failNextGet = false;
	let holdNextCreate = false;
	let createStarted: (() => void) | null = null;
	let releaseHeldCreate: (() => void) | null = null;
	let invalidationCount = 0;
	let rejectSave: ((error: Error) => void) | null = null;
	let createCount = $state(0);
	let updateCount = $state(0);
	let removeCount = $state(0);
	let lastUpdateExpectedRevision = $state<number | null>(null);
	let lastRemoveExpectedRevision = $state<number | null>(null);
	const store = createSnippetsStore({
		get: async () => {
			loadCount += 1;
			if (blockRefresh && loadCount > 1) {
				await new Promise<void>((resolve) => {
					releaseRefresh = resolve;
				});
			}
			if (holdNextGet) {
				holdNextGet = false;
				await new Promise<void>((resolve) => {
					releaseHeldGet = resolve;
				});
			}
			if (failNextGet) {
				failNextGet = false;
				throw new Error('follow-up load failed');
			}
			return current;
		},
		create: async (request) => {
			createCount += 1;
			if (holdNextCreate) {
				holdNextCreate = false;
				createStarted?.();
				createStarted = null;
				await new Promise<void>((resolve) => {
					releaseHeldCreate = resolve;
				});
			}
			if (blockSave) {
				await new Promise<void>((_resolve, reject) => {
					rejectSave = (error) => reject(error);
				});
			}
			current = {
				revision: current.revision + 1,
				snippets: sortSnippetsByShortName([
					...current.snippets,
					entry(
						`created-${current.revision}`,
						request.snippet.shortName,
						request.snippet.template,
						request.snippet.defaultArguments,
					),
				]),
			};
			return { success: true, snapshot: current };
		},
		update: async (request) => {
			updateCount += 1;
			lastUpdateExpectedRevision = request.expectedRevision;
			if (request.expectedRevision !== current.revision) {
				throw new ApiError(409, 'Snippets changed', SNIPPET_ERROR_CODES.revisionConflict);
			}
			current = {
				revision: current.revision + 1,
				snippets: sortSnippetsByShortName(
					current.snippets.map((snippet) =>
						snippet.id === request.id
							? { ...snippet, ...request.snippet, updatedAt: '2026-01-02T00:00:00.000Z' }
							: snippet,
					),
				),
			};
			return { success: true, snapshot: current };
		},
		remove: async (request) => {
			removeCount += 1;
			lastRemoveExpectedRevision = request.expectedRevision;
			if (request.expectedRevision !== current.revision) {
				throw new ApiError(409, 'Snippets changed', SNIPPET_ERROR_CODES.revisionConflict);
			}
			current = {
				revision: current.revision + 1,
				snippets: current.snippets.filter((snippet) => snippet.id !== request.id),
			};
			return { success: true, snapshot: current };
		},
	});
	function editServerOnly(): void {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.id === 'one'
						? { ...snippet, template: 'Server updated without WS', updatedAt: '2026-01-03T00:00:00.000Z' }
						: snippet,
				),
			),
		};
	}
	function renameServerOnly(): void {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.id === 'one'
						? {
								...snippet,
								shortName: 'review_server_renamed',
								template: 'Renamed without WS',
								updatedAt: '2026-01-04T00:00:00.000Z',
							}
						: snippet,
				),
			),
		};
	}
	function removeServerOnly(): void {
		current = {
			revision: current.revision + 1,
			snippets: current.snippets.filter((snippet) => snippet.id !== 'one'),
		};
	}
	function advanceUnrelated(): void {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.id === 'two'
						? { ...snippet, template: 'Other updated', updatedAt: '2026-01-05T00:00:00.000Z' }
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	function restoreLowerUnrelated(): void {
		current = {
			revision: Math.max(0, current.revision - 1),
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.id === 'two'
						? { ...snippet, template: 'Other restored', updatedAt: '2026-01-06T00:00:00.000Z' }
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	async function invalidateAndHoldChangedReload(): Promise<void> {
		const capturedRevision = store.snapshot?.revision ?? current.revision;
		holdNextCreate = true;
		const waitForCreate = new Promise<void>((resolve) => {
			createStarted = resolve;
		});
		const creating = store.create({
			shortName: 'temp_trigger',
			template: 'Temp',
			defaultArguments: '',
		});
		await waitForCreate;
		await store.refresh();
		failNextGet = true;
		releaseHeldCreate?.();
		releaseHeldCreate = null;
		await creating;
		invalidationCount += 1;
		current = {
			revision: capturedRevision,
			snippets: sortSnippetsByShortName(
				current.snippets
					.filter((snippet) => snippet.shortName !== 'temp_trigger')
					.map((snippet) =>
						snippet.id === 'one'
							? {
									...snippet,
									shortName: `review_reloaded_${invalidationCount}`,
									template: `Changed while invalidated ${invalidationCount}`,
									updatedAt: `2026-01-09T00:00:0${invalidationCount}.000Z`,
								}
							: snippet,
					),
			),
		};
		holdNextGet = true;
	}
	function advanceExternally(): void {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.shortName === 'review'
						? { ...snippet, template: 'Externally updated', updatedAt: '2026-01-03T00:00:00.000Z' }
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	function renameExternally(): void {
		current = {
			revision: current.revision + 1,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.shortName === 'review'
						? {
								...snippet,
								shortName: 'review_renamed',
								template: 'Renamed externally',
								updatedAt: '2026-01-04T00:00:00.000Z',
							}
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	function removeExternally(): void {
		current = {
			revision: current.revision + 1,
			snippets: current.snippets.filter((snippet) => snippet.shortName !== 'review'),
		};
		void store.refreshInBackground();
	}
	function restoreSameRevision(): void {
		current = {
			revision: current.revision,
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.shortName === 'review'
						? {
								...snippet,
								shortName: 'review_restored',
								template: 'Restored template',
								updatedAt: '2026-01-05T00:00:00.000Z',
							}
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	function restoreLowerRevision(): void {
		current = {
			revision: Math.max(0, current.revision - 1),
			snippets: sortSnippetsByShortName(
				current.snippets.map((snippet) =>
					snippet.id === 'one'
						? {
								...snippet,
								shortName: 'review_restored',
								template: 'Restored lower revision',
								updatedAt: '2026-01-06T00:00:00.000Z',
							}
						: snippet,
				),
			),
		};
		void store.refreshInBackground();
	}
	setSnippets(store);
	const transientLayers = new TransientLayerRegistry(new WorkspaceInteractionGate());
	setTransientLayers(transientLayers);
	const notifications = createNotificationsStore();
	setNotifications(notifications);
</script>

<svelte:window onkeydowncapture={(event) => transientLayers.handleEscape(event)} />

{#if showSection}
	<SnippetsSection active={true} />
{/if}
<div data-testid="snippet-create-count">{createCount}</div>
<div data-testid="snippet-update-count">{updateCount}</div>
<div data-testid="snippet-remove-count">{removeCount}</div>
<div data-testid="last-update-expected-revision">{lastUpdateExpectedRevision ?? ''}</div>
<div data-testid="last-remove-expected-revision">{lastRemoveExpectedRevision ?? ''}</div>
<div data-testid="snippet-notifications">
	{notifications.items.map((notification) => notification.message).join('\n')}
</div>
<button type="button" onclick={() => void store.refresh()} data-testid="begin-refresh">
	Begin refresh
</button>
<button type="button" onclick={editServerOnly} data-testid="server-edit-only">
	Server edit only
</button>
<button type="button" onclick={renameServerOnly} data-testid="server-rename-only">
	Server rename only
</button>
<button type="button" onclick={removeServerOnly} data-testid="server-remove-only">
	Server remove only
</button>
<button type="button" onclick={advanceUnrelated} data-testid="external-unrelated-edit">
	External unrelated edit
</button>
<button type="button" onclick={restoreLowerUnrelated} data-testid="external-lower-unchanged">
	Restore lower unchanged
</button>
<button type="button" onclick={() => void invalidateAndHoldChangedReload()} data-testid="invalidate-with-changed-server">
	Invalidate with changed server
</button>
<button type="button" onclick={() => { releaseHeldGet?.(); releaseHeldGet = null; }} data-testid="release-held-get">
	Release held get
</button>
<button type="button" onclick={advanceExternally} data-testid="external-edit">
	External edit
</button>
<button type="button" onclick={renameExternally} data-testid="external-rename">
	External rename
</button>
<button type="button" onclick={removeExternally} data-testid="external-remove">
	External remove
</button>
<button type="button" onclick={restoreSameRevision} data-testid="external-restore-same-revision">
	Restore same revision
</button>
<button type="button" onclick={restoreLowerRevision} data-testid="external-restore-lower-revision">
	Restore lower revision
</button>
<button type="button" onclick={() => releaseRefresh?.()} data-testid="release-refresh">
	Release refresh
</button>
<button
	type="button"
	onclick={() => rejectSave?.(new Error('save failed'))}
	data-testid="reject-save"
>
	Reject save
</button>
