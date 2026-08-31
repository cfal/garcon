<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuTrigger,
	} from '$lib/components/ui/dropdown-menu';
	import TerminalWindowMenuItems from '../TerminalWindowMenuItems.svelte';
	import * as m from '$lib/paraglide/messages.js';

	let { terminalId }: { terminalId: string } = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger>{m.workspace_window_actions()}</DropdownMenuTrigger>
	<DropdownMenuContent class="w-64">
		<TerminalWindowMenuItems {terminalId} />
	</DropdownMenuContent>
</DropdownMenu>
