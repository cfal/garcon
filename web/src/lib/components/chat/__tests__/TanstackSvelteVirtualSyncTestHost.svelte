<script lang="ts">
	import { onMount } from 'svelte';
	import { createVirtualizer } from '@tanstack/svelte-virtual';

	interface Exposure {
		resizeFirstRow(size: number): void;
	}

	interface Props {
		onReady(exposure: Exposure): void;
	}

	let { onReady }: Props = $props();
	let viewport: HTMLDivElement | null = $state(null);

	const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 3,
		estimateSize: () => 40,
		getItemKey: (index) => `row-${index}`,
		getScrollElement: () => viewport,
		initialOffset: 80,
		initialRect: { width: 320, height: 80 },
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

	onMount(() => {
		onReady({
			resizeFirstRow(size) {
				$virtualizer.resizeItem(0, size);
			},
		});
	});
</script>

<div bind:this={viewport} data-testid="viewport">
	<div data-testid="sizer" style:height={`${$virtualizer.getTotalSize()}px`}>
		{#each $virtualizer.getVirtualItems() as item (item.key)}
			<div data-testid={`row-${item.index}`} style:transform={`translateY(${item.start}px)`}>
				row {item.index}
			</div>
		{/each}
	</div>
</div>
