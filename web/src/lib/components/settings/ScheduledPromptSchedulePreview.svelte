<script lang="ts">
	import { formatScheduledDate } from '$lib/scheduling/local-schedule';
	import { scheduledInstantLabel } from '$lib/scheduling/schedule-labels';
	import type { SchedulePreview } from './scheduled-prompt-form-state.svelte';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		preview: SchedulePreview;
		currentTime: Date;
		recurring: boolean;
		cadence: string;
	}

	let { preview, currentTime, recurring, cadence }: Props = $props();

	const issueMessage = $derived.by(() => {
		switch (preview.issue) {
			case 'incomplete':
				return m.scheduled_prompts_schedule_incomplete();
			case 'past':
				return m.scheduled_prompts_schedule_past();
			case 'interval':
				return m.scheduled_prompts_schedule_interval();
			case 'end-before-start':
				return m.scheduled_prompts_schedule_end_before_start();
			default:
				return null;
		}
	});
	const lifecycle = $derived.by(() => {
		if (!recurring) return null;
		return preview.endAt
			? m.scheduled_prompts_until({ date: formatScheduledDate(preview.endAt) })
			: m.scheduled_prompts_forever().toLowerCase();
	});
</script>

<div data-slot="scheduled-prompt-schedule-preview" aria-live="polite">
	{#if issueMessage}
		<p class="flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
			<CircleAlert class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			{issueMessage}
		</p>
	{:else}
		<div class="flex items-start gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-2.5">
			<CalendarClock class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
			<div class="min-w-0 text-sm">
				<p class="font-medium text-foreground">
					{cadence}{#if lifecycle}<span class="font-normal text-muted-foreground">, {lifecycle}</span
						>{/if}
				</p>
				<p class="mt-1 text-xs text-muted-foreground">
					{recurring ? m.scheduled_prompts_preview_next_runs() : m.scheduled_prompts_preview_runs()}
				</p>
				<ul class="text-xs text-foreground">
					{#each preview.upcomingRuns as run (run)}
						<li>{scheduledInstantLabel(run, currentTime)}</li>
					{/each}
				</ul>
			</div>
		</div>
	{/if}
</div>
