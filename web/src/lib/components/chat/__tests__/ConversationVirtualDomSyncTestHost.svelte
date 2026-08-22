<script lang="ts">
	import { onMount } from 'svelte';
	import type { Attachment } from 'svelte/attachments';
	import { createVirtualizer } from '@tanstack/svelte-virtual';
	import { ConversationVirtualDomSynchronizer } from '../conversation-feed-virtual-runtime.js';

	interface Exposure {
		resizeFirstRow(size: number): void;
	}

	interface Props {
		onReady(exposure: Exposure): void;
	}

	let { onReady }: Props = $props();
	let viewport: HTMLDivElement | null = $state(null);
	let sizer: HTMLDivElement | null = $state(null);
	const virtualDom = new ConversationVirtualDomSynchronizer(() => sizer);
	const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
		count: 3,
		estimateSize: () => 40,
		getItemKey: (index) => `row-${index}`,
		getScrollElement: () => viewport,
		initialOffset: 80,
		initialRect: { width: 320, height: 80 },
		measureElement: (_element, _entry, instance) => instance.options.estimateSize(0),
		onChange: virtualDom.onChange,
		observeElementOffset: (_instance, callback) => {
			callback(80, false);
			return () => {};
		},
		observeElementRect: (_instance, callback) => {
			callback({ width: 320, height: 80 });
			return () => {};
		},
		overscan: 3,
		scrollToFn: () => {},
	});
	const measureItem: Attachment<HTMLDivElement> = (element) => {
		$virtualizer.measureElement(element);
		return () => $virtualizer.measureElement(null);
	};

	onMount(() => {
		onReady({
			resizeFirstRow(size) {
				virtualDom.setOptions($virtualizer, { overscan: 3 });
				$virtualizer.resizeItem(0, size);
			},
		});
	});
</script>

<div bind:this={viewport} data-testid="viewport">
	<div bind:this={sizer} data-testid="sizer" style:height={`${$virtualizer.getTotalSize()}px`}>
		{#each $virtualizer.getVirtualItems() as item (item.key)}
			<div
				data-index={item.index}
				data-testid={`row-${item.index}`}
				style:height="40px"
				style:transform={`translateY(${item.start}px)`}
				{@attach measureItem}
			>
				row {item.index}
			</div>
		{/each}
	</div>
</div>
