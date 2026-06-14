<script lang="ts">
	import { Collapsible as CollapsiblePrimitive } from 'bits-ui';

	let { open = $bindable(false), ...restProps }: CollapsiblePrimitive.RootProps = $props();
</script>

<CollapsiblePrimitive.Root bind:open {...restProps} />
