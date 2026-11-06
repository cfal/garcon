<script lang="ts">
	import { onMount } from 'svelte';
	import Server from '@lucide/svelte/icons/server';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { DropdownMenuItem, DropdownMenuSeparator } from '$lib/components/ui/dropdown-menu';
	import { getNativeServerChooser, type NativeServerChooser } from '$lib/native/server-chooser';
	import { getNativeLifecycle } from '$lib/native/lifecycle';
	import * as m from '$lib/paraglide/messages.js';
	let chooser = $state<NativeServerChooser | null>(null);
	let failed = $state(false);
	onMount(() => {
		chooser = getNativeServerChooser();
	});
	function openChooser(event: Event) {
		try {
			chooser?.requestServerChooser();
			failed = false;
		} catch {
			event.preventDefault();
			failed = true;
		}
	}
	function reload() {
		const lifecycle = getNativeLifecycle();
		if (lifecycle) lifecycle.requestReload();
		else window.location.reload();
	}
</script>

{#if chooser}
	<DropdownMenuSeparator />
	<DropdownMenuItem onSelect={reload}>
		<RotateCw class="h-3.5 w-3.5" />
		{m.native_reload()}
	</DropdownMenuItem>
	<DropdownMenuItem onSelect={openChooser}>
		<Server class="h-3.5 w-3.5" />
		{failed ? m.native_open_server_unavailable() : m.native_open_server()}
	</DropdownMenuItem>
{/if}
