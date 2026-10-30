<script lang="ts">
	import { ScrollArea } from 'bits-ui';

	let { type }: { type: 'scroll' | 'auto' } = $props();
</script>

<ScrollArea.Root {type}>
	<ScrollArea.Viewport>
		<div>Scrollable content</div>
	</ScrollArea.Viewport>
	<ScrollArea.Scrollbar orientation="vertical" forceMount={type === 'scroll'}>
		<ScrollArea.Thumb />
	</ScrollArea.Scrollbar>
</ScrollArea.Root>
