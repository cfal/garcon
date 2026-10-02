<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { BashToolUseMessage, UserMessage } from '$shared/chat-types';
	import { buildConversationFeedRenderModel } from '$lib/chat/transcript/conversation-feed-items.js';
	import { virtualItems, type VirtualTransactionRecord } from '$lib/virt/virtual-list-types.js';
	import type {
		ConversationFeedProjection,
		ConversationVirtualGeometrySnapshot,
	} from '../ConversationFeedProjectionState.svelte.js';
	import { ConversationFeedRetentionState } from '../ConversationFeedRetentionState.svelte.js';
	import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';
	import type {
		ConversationVirtualFeedItem,
		ConversationVirtualFeedModel,
		TranscriptVirtualFeedItem,
	} from '../conversation-feed-virtual-items.js';

	interface Exposure {
		controller: ConversationFeedVirtualController;
		transactions: readonly VirtualTransactionRecord[];
		viewport(): HTMLDivElement | null;
		initialEndRestoredCount(): number;
		appendItem(): Promise<void>;
		prependItems(): Promise<void>;
		prependDuring(activity: 'dragging' | 'coasting'): Promise<void>;
		replaceSurface(): Promise<void>;
		setPinned(value: boolean): Promise<void>;
		resetMeasurements(): Promise<void>;
		hide(): Promise<void>;
		showAtLayout(viewportWidth: number, itemSize: number): Promise<void>;
		prependGroup(): Promise<void>;
		appendGroup(): Promise<void>;
	}

	interface Props {
		onReady(exposure: Exposure): void;
		invalidInitialGeometry?: boolean;
		groupFocusMode?: boolean;
		groupTailCount?: number;
		initialPinned?: boolean;
	}

	let {
		onReady,
		invalidInitialGeometry = false,
		groupFocusMode = false,
		groupTailCount = 0,
		initialPinned = true,
	}: Props = $props();
	let itemCount = $state(12);
	let firstItemNumber = $state(0);
	let historyEarlierMutation = $state(false);
	let contentRevision = $state(0);
	let geometryRevision = $state(1);
	let measurementReset = $state<ConversationVirtualGeometrySnapshot['measurementReset']>('none');
	let pinned = $state(untrack(() => initialPinned));
	let surfaceIdentity = $state('surface-1');
	let itemEstimate = $state(40);
	let renderedItemSize = $state(40);
	let visible = $state(true);
	let viewportWidth = $state(400);
	let groupMembers = $state.raw(['b', 'c']);
	let viewportElement: HTMLDivElement | null = $state(null);
	let virtualRoot: HTMLDivElement | null = $state(null);
	let scrollbarDragActive = false;
	let releaseGroupFocus: (() => void) | null = null;
	let initialEndRestoredCount = 0;
	const transactions: VirtualTransactionRecord[] = [];
	const renderModel = buildConversationFeedRenderModel([]);

	const keys = $derived(groupFocusMode
		? [
			JSON.stringify([surfaceIdentity, `tool-group:${groupMembers[0]}`]),
			...Array.from({ length: groupTailCount }, (_, index) =>
				JSON.stringify([surfaceIdentity, `tail-${index}`])),
		]
		: Array.from({ length: itemCount }, (_, index) =>
				JSON.stringify([surfaceIdentity, firstItemNumber + index]),
			));
	const model = $derived.by((): ConversationVirtualFeedModel => {
		if (groupFocusMode) {
			const members: ConversationVirtualFeedItem[] = groupMembers.map((id, index) => ({
				kind: 'transcript',
				key: JSON.stringify([surfaceIdentity, id]),
				item: {
					kind: 'message', id, index, ordinal: index + 1,
					message: new BashToolUseMessage('2026-08-03T00:00:00.000Z', id, 'pwd'),
				},
				spacingAfter: 'none',
			}));
			const group: ConversationVirtualFeedItem = {
				kind: 'tool-group', key: keys[0], anchorId: keys[0],
				members: members.filter((member) => member.kind === 'transcript'),
				expanded: false, spacingAfter: 'none',
			};
			const tail: TranscriptVirtualFeedItem[] = keys.slice(1).map((key, index) => ({
				kind: 'transcript',
				key,
				item: {
					kind: 'message', id: `tail-${index}`, index: index + 1, ordinal: index + 10,
					message: new UserMessage('2026-08-03T00:00:00.000Z', `tail ${index}`),
				},
				spacingAfter: 'none',
			}));
			const items = [group, ...tail];
			return {
				items,
				indexByKey: new Map(keys.map((key, index) => [key, index])),
				indexByRowId: new Map([
					...groupMembers.map((id): [string, number] => [id, 0]),
					...tail.map((item, index): [string, number] => [item.item.id, index + 1]),
				]),
				targetByDomAnchorId: new Map(),
				memberRowIdByDomAnchorId: new Map(),
				representativeRowIdByKey: new Map([
					[keys[0], groupMembers[0]],
					...tail.map((item): [string, string] => [item.key, item.item.id]),
				]),
				collapsedGroupByMemberRowId: new Map(),
				transcriptStartIndex: 0,
				transcriptEndIndex: items.length,
			};
		}
		const items: ConversationVirtualFeedItem[] = keys.map((key, index) => ({
			kind: 'transcript',
			key,
			item: {
				kind: 'message',
				id: `row-${index}`,
					message: new UserMessage('2026-08-03T00:00:00.000Z', `prompt ${index}`),
					index,
					ordinal: firstItemNumber + index + 1,
			},
			spacingAfter: 'none',
		}));
		return {
			items,
			indexByKey: new Map(keys.map((key, index) => [key, index])),
			indexByRowId: new Map(),
			targetByDomAnchorId: new Map(),
			memberRowIdByDomAnchorId: new Map(),
			representativeRowIdByKey: new Map(keys.map((key, index) => [key, `row-${index}`])),
			collapsedGroupByMemberRowId: new Map(),
			transcriptStartIndex: 0,
			transcriptEndIndex: items.length,
		};
	});
	const geometry = $derived.by((): ConversationVirtualGeometrySnapshot => ({
		surfaceIdentity,
		geometryRevision,
		keys,
		estimates: keys.map(() => itemEstimate),
		measurementReset,
		mutationKinds: new Set(historyEarlierMutation ? ['history-earlier' as const] : []),
		endBehavior: 'restore-if-pinned',
	}));
	const nextProjection = $derived.by((): ConversationFeedProjection => ({
		renderModel,
		model,
		geometry,
		projectedDataRevision: contentRevision,
	}));
	const initialProjection = untrack(() => nextProjection);
	const initialGeometryIsInvalid = untrack(() => invalidInitialGeometry);
	let appliedProjection = $state.raw<ConversationFeedProjection>({
		...initialProjection,
		geometry: initialGeometryIsInvalid
			? { ...initialProjection.geometry, estimates: [] }
			: { ...initialProjection.geometry, surfaceIdentity: 'surface-before-mount' },
	});
	const retention = new ConversationFeedRetentionState();
	const controller = new ConversationFeedVirtualController({
		get model() {
			return appliedProjection.model;
		},
		get geometry() {
			return appliedProjection.geometry;
		},
		get projectedDataRevision() {
			return appliedProjection.projectedDataRevision;
		},
		get viewport() {
			return viewportElement;
		},
		get virtualRoot() {
			return virtualRoot;
		},
		get visible() {
			return visible;
		},
		get pinned() {
			return pinned;
		},
		get retention() {
			return retention;
		},
		onInitialEndRestored() {
			initialEndRestoredCount += 1;
		},
		onTransaction(record) {
			transactions.push(record);
		},
	});
	const mountedProjection = untrack(() => nextProjection);
	if (
		!controller.applyProjection({
			next: mountedProjection,
			pinned: untrack(() => pinned),
			scrollbarDragActive,
		})
	) {
		throw new Error('Expected the initial virtual projection to be accepted');
	}
	appliedProjection = mountedProjection;
	const snapshot = $derived(controller.snapshot);
	const renderedIndexes = $derived(controller.renderedIndexes(snapshot));
	const renderedItems = $derived(virtualItems(snapshot, renderedIndexes));

	$effect.pre(() => {
		const next = nextProjection;
		untrack(() => {
			if (
				controller.applyProjection({
					next,
					pinned,
					scrollbarDragActive,
				})
			) {
				appliedProjection = next;
			}
		});
	});

	const installViewportGeometry: Attachment<HTMLElement> = (element) => {
		Object.defineProperties(element, {
			clientHeight: { configurable: true, value: 200 },
			clientWidth: { configurable: true, get: () => viewportWidth },
			scrollHeight: { configurable: true, get: () => controller.snapshot.sizerSize },
		});
		element.getBoundingClientRect = () => new DOMRect(0, 0, viewportWidth, 200);
	};
	const installSizerGeometry: Attachment<HTMLElement> = (element) => {
		element.getBoundingClientRect = () =>
			new DOMRect(0, -((viewportElement?.scrollTop ?? 0) as number), 400, snapshot.sizerSize);
	};
	function installItemGeometry(): Attachment<HTMLElement> {
		return (element) => {
			Object.defineProperty(element, 'offsetHeight', {
				configurable: true,
				get: () => renderedItemSize,
			});
		};
	}

	onMount(() => {
		onReady({
			controller,
			transactions,
			viewport: () => viewportElement,
			initialEndRestoredCount: () => initialEndRestoredCount,
			appendItem,
			prependItems,
			prependDuring,
			replaceSurface,
			setPinned,
			resetMeasurements,
			hide,
			showAtLayout,
			prependGroup,
			appendGroup,
		});
	});

	onDestroy(() => {
		controller.destroy();
		retention.clear();
	});

	async function appendItem(): Promise<void> {
		historyEarlierMutation = false;
		itemCount += 1;
		measurementReset = 'none';
		geometryRevision += 1;
		contentRevision += 1;
		await tick();
	}

	async function prependItems(): Promise<void> {
		historyEarlierMutation = true;
		firstItemNumber -= 4;
		itemCount += 4;
		measurementReset = 'none';
		geometryRevision += 1;
		contentRevision += 1;
		await tick();
	}

	async function prependDuring(activity: 'dragging' | 'coasting'): Promise<void> {
		controller.setNativeScrollActivity(activity);
		await prependItems();
	}

	async function replaceSurface(): Promise<void> {
		surfaceIdentity = surfaceIdentity === 'surface-1' ? 'surface-2' : 'surface-1';
		measurementReset = 'none';
		geometryRevision += 1;
		contentRevision += 1;
		await tick();
	}

	async function setPinned(value: boolean): Promise<void> {
		pinned = value;
		await tick();
	}

	async function resetMeasurements(): Promise<void> {
		itemEstimate = itemEstimate === 40 ? 34 : 40;
		measurementReset = 'all';
		geometryRevision += 1;
		await tick();
	}

	async function hide(): Promise<void> {
		controller.prepareForHide();
		visible = false;
		await tick();
	}

	async function showAtLayout(nextViewportWidth: number, nextItemSize: number): Promise<void> {
		viewportWidth = nextViewportWidth;
		renderedItemSize = nextItemSize;
		visible = true;
		await tick();
	}

	async function prependGroup(): Promise<void> {
		groupMembers = ['a', ...groupMembers];
		geometryRevision += 1;
		contentRevision += 1;
		await tick();
	}

	async function appendGroup(): Promise<void> {
		groupMembers = [...groupMembers, 'd'];
		geometryRevision += 1;
		contentRevision += 1;
		await tick();
	}
</script>

<div
	bind:this={viewportElement}
	data-controller-viewport
	data-visible={String(visible)}
	style:display={visible ? 'block' : 'none'}
	style:height="200px"
	style:overflow="auto"
	{@attach installViewportGeometry}
	{@attach controller.viewport}
>
	<div
		bind:this={virtualRoot}
		data-controller-sizer
		data-controller-model-count={model.items.length}
		style:height={`${snapshot.sizerSize}px`}
		style:position="relative"
		{@attach installSizerGeometry}
		{@attach controller.sizer}
	>
		{#each renderedItems as virtualItem (virtualItem.key)}
			<div
				data-index={virtualItem.index}
				data-chat-virtual-item={virtualItem.key}
				style:height={`${renderedItemSize}px`}
				style:position="absolute"
				style:transform={`translateY(${virtualItem.start}px)`}
				{@attach installItemGeometry()}
				{@attach controller.item(virtualItem.key)}
			>
				{#if groupFocusMode}
					{#if virtualItem.index === 0}
						<button
							data-chat-tool-group
							data-chat-anchor-id={virtualItem.key}
							onfocus={() => {
								releaseGroupFocus?.();
								releaseGroupFocus = retention.acquire(virtualItem.key, 'focus');
							}}
							onblur={() => { releaseGroupFocus?.(); releaseGroupFocus = null; }}
						>Tool group</button>
					{/if}
				{/if}
			</div>
		{/each}
	</div>
</div>
