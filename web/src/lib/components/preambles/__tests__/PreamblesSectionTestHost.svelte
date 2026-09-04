<script lang="ts">
	import PreamblesSection from '../PreamblesSection.svelte';
	import { setAppShell, setPreambles } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import {
		PreamblesStore,
		type PreamblesStoreDeps,
	} from '$lib/preambles/preambles-store.svelte';
	import type { PreamblesSnapshot } from '$shared/preambles';
	import { untrack } from 'svelte';

	let {
		snapshot,
		deps = {},
	}: {
		snapshot: PreamblesSnapshot;
		deps?: PreamblesStoreDeps;
	} = $props();
	const preambles = new PreamblesStore(untrack(() => deps));
	preambles.applySnapshot(untrack(() => snapshot));
	setAppShell(createAppShellStore());
	setPreambles(preambles);
</script>

<PreamblesSection active={true} />
