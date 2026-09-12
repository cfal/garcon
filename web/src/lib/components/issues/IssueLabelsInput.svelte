<script lang="ts">
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import type { IssueDraftState } from '$lib/issues/drafts/issue-draft-state.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let {
		controller,
		draft,
		onKeydown,
	}: {
		controller: IssuesController;
		draft: IssueDraftState;
		onKeydown: (event: KeyboardEvent) => void;
	} = $props();
	let focused = $state(false);
	let suggestions = $state.raw<readonly string[]>([]);
	$effect(() => {
		const value = draft.field('labels');
		const partition = controller.bootstrap;
		if (!focused || !draft.canEdit || !partition) return;
		const request = new AbortController();
		const timer = setTimeout(() => {
			void controller
				.facets('label', value.split('\n').at(-1)?.trim() ?? '', request.signal)
				.then((result) => {
					if (!request.signal.aborted)
						suggestions = result.values.filter((label) => !value.split('\n').includes(label));
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
	function choose(label: string) {
		const lines = draft.field('labels').split('\n');
		lines[lines.length - 1] = label;
		draft.setField('labels', `${lines.join('\n')}\n`);
	}
</script>

<div
	onfocusout={(event) => {
		if (
			!(event.relatedTarget instanceof Node) ||
			!event.currentTarget.contains(event.relatedTarget)
		)
			focused = false;
	}}
>
	<label class="issue-field"
		>{m.issues_labels()}<textarea
			class="issue-input"
			rows="2"
			placeholder={m.issues_labels_hint()}
			value={draft.field('labels')}
			onkeydown={onKeydown}
			onfocus={() => (focused = true)}
			oninput={(event) => draft.setField('labels', event.currentTarget.value)}></textarea></label
	>
	{#if focused && draft.canEdit}<div class="issue-actions">
			{#each suggestions as label (label)}<button
					type="button"
					class="issue-text-button"
					onclick={() => choose(label)}>{label}</button
				>{/each}
		</div>{/if}
</div>
