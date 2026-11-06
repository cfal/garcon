<script lang="ts">
	import { onMount } from 'svelte';
	import PanelTop from '@lucide/svelte/icons/panel-top';
	import { DropdownMenuCheckboxItem } from '$lib/components/ui/dropdown-menu';
	import {
		getNativeTitlebar,
		type NativeTitlebar,
		type NativeTitlebarSnapshot,
	} from '$lib/native/titlebar';
	import * as m from '$lib/paraglide/messages.js';

	let titlebar = $state<NativeTitlebar | null>(null);
	let snapshot = $state<NativeTitlebarSnapshot>({ hidden: false, failed: false });

	onMount(() => {
		titlebar = getNativeTitlebar();
		return titlebar?.subscribe((value) => {
			snapshot = value;
		});
	});

	function setHidden(hidden: boolean) {
		try {
			titlebar?.requestHidden(hidden);
		} catch {
			snapshot = { hidden: snapshot.hidden, failed: true };
		}
	}
</script>

{#if titlebar}
	<DropdownMenuCheckboxItem
		checked={snapshot.hidden}
		onCheckedChange={setHidden}
		closeOnSelect={false}
	>
		<PanelTop class="h-3.5 w-3.5" />
		{snapshot.failed ? m.native_titlebar_unavailable() : m.native_hide_titlebar()}
	</DropdownMenuCheckboxItem>
{/if}
