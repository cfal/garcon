<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
		DropdownMenuItem,
	} from '$lib/components/ui/dropdown-menu';
	import NativeServerChooserItem from '../NativeServerChooserItem.svelte';
	import NativeTitlebarItem from '../NativeTitlebarItem.svelte';
</script>

<DropdownMenu>
	<DropdownMenuTrigger>Menu</DropdownMenuTrigger>
	<DropdownMenuContent>
		<DropdownMenuItem>Settings</DropdownMenuItem>
		<NativeServerChooserItem />
		<NativeTitlebarItem />
	</DropdownMenuContent>
</DropdownMenu>
