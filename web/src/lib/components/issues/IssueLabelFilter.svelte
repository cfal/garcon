<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let { controller }: { controller: IssuesController } = $props();
	const id = $props.id();
	let value = $derived(controller.query.label ?? '');
	let focused = $state(false);
	let suggestions = $state.raw<readonly string[]>([]);
	$effect(() => {
		if (!focused) return;
		const prefix = value;
		const partition = controller.bootstrap;
		const request = new AbortController();
		const timer = setTimeout(() => {
			void controller
				.facets('label', prefix, request.signal)
				.then((result) => {
					if (!request.signal.aborted && controller.bootstrap === partition)
						suggestions = result.values;
				})
				.catch(() => {
					if (!request.signal.aborted) suggestions = [];
				});
		}, 150);
		return () => {
			clearTimeout(timer);
			request.abort();
		};
	});
</script>

<label class="issue-field">
	{m.issues_label_filter()}
	<input
		class="issue-input"
		name="label"
		bind:value
		list={id}
		placeholder={m.issues_any_label()}
		title={m.issues_label_filter_hint()}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
	/>
</label>
<datalist {id}>
	{#each suggestions as label (label)}<option value={label}></option>{/each}
</datalist>
