<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
	} from '$lib/components/ui/dropdown-menu';
	import NativeServerChooserItem from '../NativeServerChooserItem.svelte';
</script>

<DropdownMenu>
	<DropdownMenuTrigger>Menu</DropdownMenuTrigger>
	<DropdownMenuContent><NativeServerChooserItem /></DropdownMenuContent>
</DropdownMenu>
