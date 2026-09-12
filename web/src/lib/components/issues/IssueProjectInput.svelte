<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		value,
		onChange,
		onKeydown,
		disabled = false,
		label = m.issues_project(),
		placeholder = '',
	}: {
		controller: IssuesController;
		value: string;
		onChange: (value: string) => void;
		disabled?: boolean;
		label?: string;
		placeholder?: string;
		onKeydown?: (event: KeyboardEvent) => void;
	} = $props();
	const id = $props.id();
	let focused = $state(false);
	let suggestions = $state.raw<readonly string[]>([]);
	$effect(() => {
		if (!focused || disabled) return;
		const prefix = value;
		const partition = controller.bootstrap;
		const request = new AbortController();
		const timer = setTimeout(() => {
			void controller
				.facets('project', prefix, request.signal)
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

<label class="issue-field" for={id}
	>{label}
	<input
		{id}
		list={`${id}-projects`}
		class="issue-input"
		{value}
		{disabled}
		{placeholder}
		title={value}
		onkeydown={onKeydown}
		oninput={(event) => onChange(event.currentTarget.value)}
		onfocus={() => (focused = true)}
		onblur={() => (focused = false)}
	/>
</label>
<datalist id={`${id}-projects`}
	>{#each suggestions as project (project)}<option value={project}></option>{/each}</datalist
>
