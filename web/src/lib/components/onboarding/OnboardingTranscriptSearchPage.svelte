<script lang="ts">
	import { onMount } from 'svelte';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { Switch } from '$lib/components/ui/switch';
	import { Button } from '$lib/components/ui/button';
	import type { OnboardingTranscriptSearchState } from './onboarding-transcript-search-state.svelte.js';
	import * as m from '$lib/paraglide/messages.js';

	let { search }: { search: OnboardingTranscriptSearchState } = $props();
	let searchSwitch = $state<HTMLButtonElement | null>(null);

	onMount(() => {
		search.activate();
		return () => search.deactivate();
	});
</script>

<div class="space-y-4 text-sm leading-relaxed">
	<div class="border-b border-border pb-4">
		<div class="flex items-center justify-between gap-4">
			<label for="onboarding-transcript-search" class="font-medium">
				{m.settings_transcript_search()}
			</label>
			<Switch
				bind:ref={searchSwitch}
				id="onboarding-transcript-search"
				bind:checked={() => search.enabled, (checked) => void search.setEnabled(checked)}
				aria-disabled={search.isSaving}
				class="aria-disabled:cursor-wait aria-disabled:opacity-50"
				aria-describedby="onboarding-search-scope"
			/>
		</div>
		<p id="onboarding-search-scope" class="mt-2 text-xs text-muted-foreground">
			{m.onboarding_search_scope()}
		</p>
		{#if search.isSaving}
			<p role="status" class="mt-2 text-xs text-muted-foreground">
				{m.onboarding_search_saving()}
			</p>
		{/if}
		{#if search.error}
			<div class="mt-2 flex items-center justify-between gap-3">
				<p role="alert" class="text-xs text-destructive">{search.error}</p>
				<Button
					variant="outline"
					size="sm"
					onclick={() => {
						searchSwitch?.focus({ preventScroll: true });
						search.retry();
					}}
				>
					{m.common_retry()}
				</Button>
			</div>
		{/if}
	</div>
	<p>{m.onboarding_search_ledger()}</p>
	<p class="text-muted-foreground">{m.onboarding_search_agents()}</p>
	<blockquote class="border-l-2 border-primary pl-4 font-medium">
		{m.onboarding_search_example()}
	</blockquote>
	<a
		href="https://github.com/cfal/garcon-skills"
		target="_blank"
		rel="noopener noreferrer"
		class="inline-flex items-center gap-1.5 text-primary underline underline-offset-4"
	>
		{m.onboarding_search_skills_link()}
		<ExternalLinkIcon class="size-3.5 shrink-0" />
	</a>
	<p class="text-xs text-muted-foreground">
		{m.onboarding_search_remote_access({ setting: m.executors_allow_cli() })}
	</p>
</div>
