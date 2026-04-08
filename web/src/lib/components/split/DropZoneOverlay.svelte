<script lang="ts">
	import { cn } from '$lib/utils/cn';

	type DropZone = 'left' | 'right' | 'top' | 'bottom';

	interface DropZoneOverlayProps {
		onDrop: (zone: DropZone) => void;
	}

	let { onDrop }: DropZoneOverlayProps = $props();

	let hoveredZone = $state<DropZone | null>(null);

	function handleDragOver(zone: DropZone) {
		return (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			hoveredZone = zone;
		};
	}

	function handleDrop(zone: DropZone) {
		return (e: DragEvent) => {
			e.preventDefault();
			hoveredZone = null;
			onDrop(zone);
		};
	}

	function handleDragLeave() {
		hoveredZone = null;
	}

	const zoneClass = (zone: DropZone) =>
		cn(
			'transition-all duration-150 flex items-center justify-center',
			'border-2 border-dashed rounded-md',
			hoveredZone === zone
				? 'bg-primary/15 border-primary/50 scale-[0.98]'
				: 'bg-transparent border-transparent hover:bg-primary/5 hover:border-primary/20',
		);
</script>

<div class="absolute inset-0 z-30 grid grid-cols-3 grid-rows-3 gap-0.5 p-2 pointer-events-auto">
	<!-- Top zone -->
	<div
		class={cn(zoneClass('top'), 'col-span-3 row-start-1')}
		ondragover={handleDragOver('top')}
		ondragleave={handleDragLeave}
		ondrop={handleDrop('top')}
		role="region"
		aria-label="Drop here to split top"
	>
		{#if hoveredZone === 'top'}
			<span class="text-xs text-primary font-medium pointer-events-none">Top</span>
		{/if}
	</div>

	<!-- Left zone -->
	<div
		class={cn(zoneClass('left'), 'row-start-2 col-start-1')}
		ondragover={handleDragOver('left')}
		ondragleave={handleDragLeave}
		ondrop={handleDrop('left')}
		role="region"
		aria-label="Drop here to split left"
	>
		{#if hoveredZone === 'left'}
			<span class="text-xs text-primary font-medium pointer-events-none">Left</span>
		{/if}
	</div>

	<!-- Center (no-op zone, provides visual gap) -->
	<div class="row-start-2 col-start-2"></div>

	<!-- Right zone -->
	<div
		class={cn(zoneClass('right'), 'row-start-2 col-start-3')}
		ondragover={handleDragOver('right')}
		ondragleave={handleDragLeave}
		ondrop={handleDrop('right')}
		role="region"
		aria-label="Drop here to split right"
	>
		{#if hoveredZone === 'right'}
			<span class="text-xs text-primary font-medium pointer-events-none">Right</span>
		{/if}
	</div>

	<!-- Bottom zone -->
	<div
		class={cn(zoneClass('bottom'), 'col-span-3 row-start-3')}
		ondragover={handleDragOver('bottom')}
		ondragleave={handleDragLeave}
		ondrop={handleDrop('bottom')}
		role="region"
		aria-label="Drop here to split bottom"
	>
		{#if hoveredZone === 'bottom'}
			<span class="text-xs text-primary font-medium pointer-events-none">Bottom</span>
		{/if}
	</div>
</div>
