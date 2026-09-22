<script lang="ts">
	import {
		DropdownMenu,
		DropdownMenuTrigger,
		DropdownMenuContent,
	} from '$lib/components/ui/dropdown-menu';
	import TerminalCreateAction from '../TerminalCreateAction.svelte';
	import type { TerminalRegistry } from '$lib/terminal/sessions/terminal-registry.svelte.js';
	let {
		terminals,
		oncreate,
	}: {
		terminals: Pick<TerminalRegistry, 'hosts' | 'hasRemoteHosts' | 'canCreate'>;
		oncreate: (nodeId?: string) => void;
	} = $props();
	let menuChoosesHost = $state(false);
</script>

<DropdownMenu
	onOpenChange={(open) => {
		if (open) menuChoosesHost = terminals.hasRemoteHosts;
	}}
>
	<DropdownMenuTrigger>Add</DropdownMenuTrigger>
	<DropdownMenuContent>
		<TerminalCreateAction {terminals} {oncreate} {menuChoosesHost} mode="menu" />
	</DropdownMenuContent>
</DropdownMenu>
