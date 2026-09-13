<script lang="ts">
	import type { IssueDetail, IssueLinkKind } from '$shared/issues';
	import type { IssuesController } from '$lib/issues/catalog/issues-controller.svelte.js';
	import * as m from '$lib/paraglide/messages.js';
	let { controller, detail }: { controller: IssuesController; detail: IssueDetail } = $props();
	let target = $state('');
	let kind = $state<IssueLinkKind>('blocks');
	let pending = $state(false);
	async function link() {
		if (pending || !/^G-[1-9]\d*$/.test(target.trim())) return;
		pending = true;
		try {
			await controller.link(detail.issue, target.trim(), kind, 'link');
		} finally {
			pending = false;
		}
	}
</script>

<details class="issue-relationships">
	<summary>{m.issues_related()} · {detail.links.length}</summary>
	{#each detail.links as link (`${link.kind}:${link.sourceId}:${link.targetId}`)}
		{@const other = link.sourceId === detail.issue.id ? link.targetId : link.sourceId}
		<div class="issue-actions">
			<span class="issue-muted"
				>{link.kind === 'related'
					? m.issues_related()
					: link.sourceId === detail.issue.id
						? m.issues_blocks()
						: m.issues_blocked_by()}</span
			>
			<button type="button" class="issue-text-button" onclick={() => controller.select(other)}
				>{other}</button
			>
			<button
				type="button"
				class="issue-text-button"
				aria-label={`${m.issues_unlink()} ${other}`}
				onclick={() => void controller.unlink(link)}>{m.issues_remove()}</button
			>
		</div>
	{:else}<p class="issue-muted">{m.issues_no_links()}</p>{/each}
	<form
		class="issue-actions"
		onsubmit={(event) => {
			event.preventDefault();
			void link();
		}}
	>
		<label class="issue-field"
			><span class="sr-only">{m.issues_related()}</span><select
				class="issue-input"
				bind:value={kind}
				><option value="blocks">{m.issues_blocks()}</option><option value="related"
					>{m.issues_related()}</option
				></select
			></label
		>
		<label class="issue-field"
			><span class="sr-only">{m.issues_target()}</span><input
				class="issue-input"
				placeholder="G-42"
				bind:value={target}
			/></label
		>
		<button class="issue-button" disabled={pending || !/^G-[1-9]\d*$/.test(target.trim())}
			>{m.issues_link()}</button
		>
	</form>
</details>
