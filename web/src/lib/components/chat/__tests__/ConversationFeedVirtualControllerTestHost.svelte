<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { SvelteVirtualizer } from '@tanstack/svelte-virtual';
	import { UserMessage } from '$shared/chat-types';
	import type { ConversationVirtualGeometrySnapshot } from '../ConversationFeedProjectionState.svelte.js';
	import { ConversationFeedRetentionState } from '../ConversationFeedRetentionState.svelte.js';
	import { ConversationFeedVirtualController } from '../ConversationFeedVirtualController.svelte.js';
	import type {
		ConversationVirtualFeedItem,
		ConversationVirtualFeedModel,
	} from '../conversation-feed-virtual-items.js';

	interface Exposure {
		controller: ConversationFeedVirtualController;
		instance: SvelteVirtualizer<HTMLElement, HTMLDivElement>;
		initialEndRestoredCount(): number;
		releaseWithheldEndItem(): Promise<void>;
		restoreHiddenWithConcurrentGeometry(): Promise<void>;
		withholdEndItem(): Promise<void>;
		withholdItem(index: number): Promise<void>;
	}

	interface Props {
		onReady(exposure: Exposure): void;
	}

	let { onReady }: Props = $props();
	let itemCount = $state(12);
	let contentRevision = $state(0);
	let geometryRevision = $state(1);
	let measurementReset = $state<ConversationVirtualGeometrySnapshot['measurementReset']>('none');
	let pinned = $state(true);
	let surfaceIdentity = $state('surface-1');
	let textScale = $state(1);
	let visible = $state(true);
	let viewport: HTMLDivElement | null = $state(null);
	let virtualRoot: HTMLDivElement | null = $state(null);
	let releaseRetention: (() => void) | null = null;
	let initialEndRestoredCount = 0;
	let withheldIndex: number | null = $state(null);

	const keys = $derived(
		Array.from({ length: itemCount }, (_, index) => JSON.stringify([surfaceIdentity, index])),
	);
	const model = $derived.by((): ConversationVirtualFeedModel => {
		void contentRevision;
		// Transcript-kind items keep reading-anchor capture eligible, matching production feeds.
		const items: ConversationVirtualFeedItem[] = keys.map((key, index) => ({
			kind: 'transcript',
			key,
			item: {
				kind: 'message',
				id: `row-${index}`,
				rowIds: [`row-${index}`],
				virtualKey: `row-${index}`,
				message: new UserMessage('2026-08-03T00:00:00.000Z', `prompt ${index}`),
				index,
				prevMessage: null,
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
	const geometry = $derived.by((): ConversationVirtualGeometrySnapshot => ({
		surfaceIdentity,
		geometryRevision,
		keys,
		estimates: keys.map(() => 40 * textScale),
		measurementReset,
		mutationKinds: new Set(),
		endBehavior: 'restore-if-pinned',
	}));
	const retention = new ConversationFeedRetentionState();
	const controller = new ConversationFeedVirtualController({
		get model() {
			return model;
		},
		get geometry() {
			return geometry;
		},
		get projectedDataRevision() {
			return contentRevision;
		},
		get viewport() {
			return viewport;
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
	});
	const virtualizer = controller.virtualizer;

	onMount(() => {
		let instance: SvelteVirtualizer<HTMLElement, HTMLDivElement> | undefined;
		const unsubscribe = controller.virtualizer.subscribe((value) => {
			instance ??= value;
		});
		unsubscribe();
		if (!instance) throw new Error('Expected the virtualizer store to emit synchronously');
		onReady({
			controller,
			instance,
			initialEndRestoredCount: () => initialEndRestoredCount,
			releaseWithheldEndItem,
			restoreHiddenWithConcurrentGeometry,
			withholdEndItem,
			withholdItem,
		});
	});

	onDestroy(() => {
		releaseRetention?.();
		controller.destroy();
	});

	function publishContent(): void {
		contentRevision += 1;
	}

	function retainFirst(): void {
		releaseRetention?.();
		releaseRetention = retention.acquire(keys[0] ?? 'missing', 'focus');
	}

	function shrink(): void {
		controller.prepareForGeometryPublication(geometryRevision + 1);
		itemCount = 4;
		measurementReset = 'none';
		geometryRevision += 1;
	}

	function appendItem(): void {
		controller.prepareForGeometryPublication(geometryRevision + 1);
		itemCount += 1;
		measurementReset = 'none';
		geometryRevision += 1;
	}

	function toggleScale(): void {
		controller.prepareForGeometryPublication(geometryRevision + 1);
		textScale = textScale === 1 ? 0.85 : 1;
		measurementReset = 'all';
		geometryRevision += 1;
	}

	function replaceSurface(): void {
		controller.prepareForGeometryPublication(geometryRevision + 1);
		surfaceIdentity = surfaceIdentity === 'surface-1' ? 'surface-2' : 'surface-1';
		measurementReset = 'none';
		geometryRevision += 1;
	}

	async function showAndRestore(): Promise<void> {
		visible = true;
		await tick();
		controller.scrollToEnd();
	}

	async function restoreHiddenWithConcurrentGeometry(): Promise<void> {
		visible = false;
		await tick();
		visible = true;
		await tick();
		const restore = controller.restoreHiddenReadingPosition();
		// Mimics a show-time clamp before the concurrent scale geometry publishes.
		if (viewport) viewport.scrollTop = 0;
		controller.prepareForGeometryPublication(geometryRevision + 1);
		textScale = 0.85;
		measurementReset = 'all';
		geometryRevision += 1;
		await restore;
	}

	async function withholdEndItem(): Promise<void> {
		await withholdItem($virtualizer.getVirtualItems().at(-1)?.index ?? -1);
	}

	async function withholdItem(index: number): Promise<void> {
		withheldIndex = index >= 0 ? index : null;
		await tick();
	}

	async function releaseWithheldEndItem(): Promise<void> {
		withheldIndex = null;
		await tick();
	}
</script>

<div
	bind:this={viewport}
	data-controller-viewport
	data-visible={String(visible)}
	style:display={visible ? 'block' : 'none'}
	style:height="200px"
	style:overflow="auto"
>
	<div
		bind:this={virtualRoot}
		data-controller-sizer
		data-controller-model-count={model.items.length}
		style:height={`${$virtualizer.getTotalSize()}px`}
		style:position="relative"
	>
		{#each $virtualizer.getVirtualItems() as virtualItem (virtualItem.key)}
			{#if virtualItem.index !== withheldIndex}
				<div
					data-index={virtualItem.index}
					data-chat-virtual-item={String(virtualItem.key)}
					style:height={`${geometry.estimates[virtualItem.index]}px`}
					style:position="absolute"
					style:transform={`translateY(${virtualItem.start}px)`}
					{@attach controller.measureItem}
				></div>
			{/if}
		{/each}
	</div>
</div>

<button onclick={publishContent}>Publish content</button>
<button onclick={appendItem}>Append</button>
<button onclick={retainFirst}>Retain first</button>
<button onclick={shrink}>Shrink</button>
<button onclick={toggleScale}>Toggle scale</button>
<button onclick={() => (pinned = !pinned)}>Toggle pinned</button>
<button onclick={() => (visible = false)}>Hide</button>
<button onclick={showAndRestore}>Show and restore</button>
<button onclick={replaceSurface}>Replace surface</button>
