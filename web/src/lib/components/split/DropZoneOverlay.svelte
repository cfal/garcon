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
	<div class={cn('absolute inset-0 pointer-events-none transition-colors duration-100', hoveredZone !== null && 'bg-primary/5')}>
		<!-- Split preview: highlighted half showing where the new pane goes -->
		<div class={cn('absolute bg-primary/15 border-2 border-primary/40 rounded-md transition-all duration-150', previewClass('top'), 'inset-x-2 top-2 bottom-[52%]')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">Split Top</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/15 border-2 border-primary/40 rounded-md transition-all duration-150', previewClass('bottom'), 'inset-x-2 top-[52%] bottom-2')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">Split Bottom</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/15 border-2 border-primary/40 rounded-md transition-all duration-150', previewClass('left'), 'inset-y-2 left-2 right-[52%]')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">Split Left</span>
			</div>
		</div>
		<div class={cn('absolute bg-primary/15 border-2 border-primary/40 rounded-md transition-all duration-150', previewClass('right'), 'inset-y-2 left-[52%] right-2')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded">Split Right</span>
			</div>
		</div>
		<div class={cn('absolute bg-accent/20 border-2 border-accent/50 rounded-md transition-all duration-150', previewClass('center'), 'inset-2')}>
			<div class="flex items-center justify-center h-full">
				<span class="text-xs font-medium text-accent-foreground bg-accent/20 px-2 py-0.5 rounded">Replace</span>
			</div>
		</div>
	</div>
</div>
