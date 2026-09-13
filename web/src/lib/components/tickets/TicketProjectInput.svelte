<script lang="ts">
	import type { TicketsController } from '$lib/tickets/catalog/tickets-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	import Folder from '@lucide/svelte/icons/folder';
	let {
		controller,
		value,
		onChange,
		onKeydown,
		disabled = false,
		label = m.tickets_project(),
		placeholder = m.tickets_project(),
	}: {
		controller: TicketsController;
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

<label class="ticket-field ticket-project-field" for={id}>
	<span class="sr-only">{label}</span>
	<span class="ticket-project-control">
		<Folder class="ticket-project-icon" size={15} aria-hidden="true" />
		<input
			{id}
			list={`${id}-projects`}
			class="ticket-input"
			{value}
			{disabled}
			{placeholder}
			title={value}
			onkeydown={onKeydown}
			oninput={(event) => onChange(event.currentTarget.value)}
			onfocus={() => (focused = true)}
			onblur={() => (focused = false)}
		/>
	</span>
</label>
<datalist id={`${id}-projects`}
	>{#each suggestions as project (project)}<option value={project}></option>{/each}</datalist
>
