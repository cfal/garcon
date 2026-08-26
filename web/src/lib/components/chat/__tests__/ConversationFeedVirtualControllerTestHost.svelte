<script lang="ts">
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { UserMessage } from '$shared/chat-types';
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
		toggleScale(): Promise<void>;
		hideAndShow(): Promise<void>;
	}

	interface Props {
		onReady(exposure: Exposure): void;
	}

	let { onReady }: Props = $props();
	let itemCount = $state(12);
	let firstItemNumber = $state(0);
	let historyEarlierMutation = $state(false);
	let contentRevision = $state(0);
	let geometryRevision = $state(1);
	let measurementReset = $state<ConversationVirtualGeometrySnapshot['measurementReset']>('none');
	let pinned = $state(true);
	let surfaceIdentity = $state('surface-1');
	let textScale = $state(1);
	let visible = $state(true);
	let viewportElement: HTMLDivElement | null = $state(null);
	let virtualRoot: HTMLDivElement | null = $state(null);
	let scrollbarDragActive = false;
	let initialEndRestoredCount = 0;
	const transactions: VirtualTransactionRecord[] = [];
	const renderModel = buildConversationFeedRenderModel([]);

	const keys = $derived(
		Array.from({ length: itemCount }, (_, index) =>
			JSON.stringify([surfaceIdentity, firstItemNumber + index]),
		),
	);
	const model = $derived.by((): ConversationVirtualFeedModel => {
		const items: ConversationVirtualFeedItem[] = keys.map((key, index) => ({
			kind: 'transcript',
			key,
			item: {
				kind: 'message',
				id: `row-${index}`,
				message: new UserMessage('2026-08-03T00:00:00.000Z', `prompt ${index}`),
				index,
			},
			spacingAfter: 'none',
		}));
		return {
			items,
			indexByKey: new Map(keys.map((key, index) => [key, index])),
			indexByRowId: new Map(),
			targetByDomAnchorId: new Map(),
			transcriptStartIndex: 0,
			transcriptEndIndex: items.length,
		};
	});
	const geometry = $derived.by(
		(): ConversationVirtualGeometrySnapshot => ({
			surfaceIdentity,
			geometryRevision,
			keys,
			estimates: keys.map(() => 40 * textScale),
			measurementReset,
			mutationKinds: new Set(historyEarlierMutation ? ['history-earlier' as const] : []),
			endBehavior: 'restore-if-pinned',
		}),
	);
	const nextProjection = $derived.by(
		(): ConversationFeedProjection => ({
			renderModel,
			model,
			geometry,
			projectedDataRevision: contentRevision,
		}),
	);
	let appliedProjection = $state.raw<ConversationFeedProjection>(untrack(() => nextProjection));
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
	const snapshot = $derived(controller.snapshot);
	const renderedIndexes = $derived(controller.renderedIndexes(snapshot));
	const renderedItems = $derived(virtualItems(snapshot, renderedIndexes));

	$effect.pre(() => {
		const next = nextProjection;
		untrack(() => {
			const previous = appliedProjection;
			if (
				controller.applyProjection({
					previous,
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
			scrollHeight: { configurable: true, get: () => controller.snapshot.sizerSize },
		});
		element.getBoundingClientRect = () => new DOMRect(0, 0, 400, 200);
	};
	const installSizerGeometry: Attachment<HTMLElement> = (element) => {
		element.getBoundingClientRect = () =>
			new DOMRect(0, -((viewportElement?.scrollTop ?? 0) as number), 400, snapshot.sizerSize);
	};
	function installItemGeometry(index: number): Attachment<HTMLElement> {
		return (element) => {
			Object.defineProperty(element, 'offsetHeight', {
				configurable: true,
				value: geometry.estimates[index] ?? 0,
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
			toggleScale,
			hideAndShow,
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

	async function toggleScale(): Promise<void> {
		textScale = textScale === 1 ? 0.85 : 1;
		measurementReset = 'all';
		geometryRevision += 1;
		await tick();
	}

	async function hideAndShow(): Promise<void> {
		controller.prepareForHide();
		visible = false;
		await tick();
		visible = true;
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
				style:height={`${geometry.estimates[virtualItem.index]}px`}
				style:position="absolute"
				style:transform={`translateY(${virtualItem.start}px)`}
				{@attach installItemGeometry(virtualItem.index)}
				{@attach controller.item(virtualItem.key)}
			></div>
		{/each}
	</div>
</div>
