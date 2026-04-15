<script lang="ts">
	import { cn } from '$lib/utils/cn';

	type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center';

	interface DropZoneOverlayProps {
		onDrop: (zone: DropZone) => void;
	}

	let { onDrop }: DropZoneOverlayProps = $props();

	let hoveredZone = $state<DropZone | null>(null);

	function handleDragOver(zone: DropZone) {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
			hoveredZone = zone;
		};
	}

	function handleDrop(zone: DropZone) {
		return (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			hoveredZone = null;
			onDrop(zone);
		};
	}

	function handleDragLeave(e: DragEvent) {
		// Only clear if leaving the overlay entirely, not moving between zones.
		const related = e.relatedTarget as HTMLElement | null;
		if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
			hoveredZone = null;
		}
	}

	function handleZoneDragLeave(e: DragEvent) {
		const related = e.relatedTarget as HTMLElement | null;
		if (!related || !(e.currentTarget as HTMLElement).contains(related)) {
			hoveredZone = null;
		}
	}

	// Preview highlight shows where the new pane would appear.
	const previewClass = (zone: DropZone) => {
		if (hoveredZone !== zone) return 'opacity-0';
		return 'opacity-100';
	};
</script>

<!-- Full overlay that intercepts all drag events -->
<div
	class="absolute inset-0 z-30 pointer-events-auto"
	ondragleave={handleDragLeave}
	role="region"
	aria-label="Drop zone overlay"
>
	<!-- svelte-ignore a11y_no_static_element_interactions -- invisible drag hit targets, not interactive elements -->
	<div class="absolute inset-0 z-10">
		<!-- Top edge -->
		<div
			class="absolute top-0 left-0 right-0 h-[25%]"
			ondragover={handleDragOver('top')}
			ondragleave={handleZoneDragLeave}
			ondrop={handleDrop('top')}
		></div>
		<!-- Bottom edge -->
		<div
			class="absolute bottom-0 left-0 right-0 h-[25%]"
			ondragover={handleDragOver('bottom')}
			ondragleave={handleZoneDragLeave}
			ondrop={handleDrop('bottom')}
		></div>
		<!-- Left edge -->
		<div
			class="absolute top-[25%] left-0 bottom-[25%] w-[25%]"
			ondragover={handleDragOver('left')}
			ondragleave={handleZoneDragLeave}
			ondrop={handleDrop('left')}
		></div>
		<!-- Right edge -->
		<div
			class="absolute top-[25%] right-0 bottom-[25%] w-[25%]"
			ondragover={handleDragOver('right')}
			ondragleave={handleZoneDragLeave}
			ondrop={handleDrop('right')}
		></div>
		<!-- Center zone: replace this pane entirely -->
		<div
			class="absolute top-[25%] left-[25%] right-[25%] bottom-[25%]"
			ondragover={handleDragOver('center')}
			ondragleave={handleZoneDragLeave}
			ondrop={handleDrop('center')}
		></div>
	</div>

	<!-- Visual feedback layer (pointer-events-none, purely decorative) -->
	<div class={cn('absolute inset-0 pointer-events-none transition-all duration-200', hoveredZone !== null ? 'bg-background/60 backdrop-blur-[1px]' : 'bg-background/30')}>
		<!-- Split preview: highlighted half showing where the new pane goes -->
		<div class={cn('absolute bg-primary/12 border border-primary/30 rounded-lg transition-all duration-200', previewClass('top'), 'inset-x-3 top-3 bottom-[52%]')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md shadow-sm">Top</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/12 border border-primary/30 rounded-lg transition-all duration-200', previewClass('bottom'), 'inset-x-3 top-[52%] bottom-3')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md shadow-sm">Bottom</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/12 border border-primary/30 rounded-lg transition-all duration-200', previewClass('left'), 'inset-y-3 left-3 right-[52%]')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md shadow-sm">Left</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/12 border border-primary/30 rounded-lg transition-all duration-200', previewClass('right'), 'inset-y-3 left-[52%] right-3')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-md shadow-sm">Right</span>
			</div>
		</div>
		<div class={cn('absolute bg-accent/15 border border-accent/40 rounded-lg transition-all duration-200', previewClass('center'), 'inset-3')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-[10px] font-medium text-accent-foreground bg-accent/15 px-2 py-0.5 rounded-md shadow-sm">Replace</span>
			</div>
		</div>
	</div>
</div>
