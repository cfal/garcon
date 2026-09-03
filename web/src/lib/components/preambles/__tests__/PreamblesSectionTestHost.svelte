<script lang="ts">
	import PreamblesSection from '../PreamblesSection.svelte';
	import { setAppShell, setPreambles } from '$lib/context';
	import { createAppShellStore } from '$lib/stores/app-shell.svelte';
	import { PreamblesStore } from '$lib/preambles/preambles-store.svelte';
	import type { PreamblesSnapshot } from '$shared/preambles';
	import { untrack } from 'svelte';

	let { snapshot }: { snapshot: PreamblesSnapshot } = $props();
	const preambles = new PreamblesStore();
	preambles.applySnapshot(untrack(() => snapshot));
	setAppShell(createAppShellStore());
	setPreambles(preambles);
</script>

<PreamblesSection active={true} />
