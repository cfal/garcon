<script lang="ts">
	import { untrack } from 'svelte';
	import FileConflictDiff from '../FileConflictDiff.svelte';

	let {
		onChange,
		initialLocal = 'local',
		lineSeparator = '\n',
	}: {
		onChange(content: string): void;
		initialLocal?: string;
		lineSeparator?: '\n' | '\r' | '\r\n';
	} = $props();
	let local = $state(untrack(() => initialLocal));
	$effect(() => onChange(local));
</script>

<FileConflictDiff comparison="disk" {lineSeparator} bind:local />
