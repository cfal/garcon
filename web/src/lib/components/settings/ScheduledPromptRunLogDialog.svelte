<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import {
		scheduledInstantLabel,
		scheduledRunOutcomeLabel,
		scheduledRunSourceLabel,
	} from '$lib/scheduling/schedule-labels';
	import { formatScheduledInstant } from '$lib/scheduling/local-schedule';
	import type { ScheduledPromptRunLogEntry } from '$shared/scheduled-prompts';
	import ScheduledRunOutcomeIcon from './ScheduledRunOutcomeIcon.svelte';
	import * as m from '$lib/paraglide/messages.js';

	interface Props {
		open: boolean;
		entries: ScheduledPromptRunLogEntry[];
		currentTime: Date;
		openableChatId: (chatId: string | null) => string | null;
		onOpenChat: (chatId: string) => void;
		onClose: () => void;
	}

	let { open, entries, currentTime, openableChatId, onOpenChat, onClose }: Props = $props();

	const newestFirst = $derived([...entries].reverse());
</script>

<Dialog.Root {open} onOpenChange={(value) => !value && onClose()}>
	<Dialog.Content class="flex max-h-[80dvh] flex-col sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>{m.scheduled_prompts_run_log()}</Dialog.Title>
			<Dialog.Description>{m.scheduled_prompts_run_log_description()}</Dialog.Description>
		</Dialog.Header>
		<div class="min-h-32 overflow-y-auto rounded-md border border-border">
			{#if newestFirst.length === 0}
				<p class="px-3 py-8 text-center text-sm text-muted-foreground">
					{m.scheduled_prompts_run_log_empty()}
				</p>
			{:else}
				<ol class="divide-y divide-border">
					{#each newestFirst as entry, index (`${entries.length - index}:${entry.at}`)}
						{@const chatId = openableChatId(entry.chatId)}
						{@const showDetail = entry.outcome === 'failed' || entry.outcome === 'missed'}
						<li class="flex min-w-0 items-start gap-2.5 px-3 py-2.5" data-slot="scheduled-run-entry">
							<ScheduledRunOutcomeIcon outcome={entry.outcome} class="mt-0.5 h-4 w-4" />
							<div class="min-w-0 flex-1">
								<p class="text-sm font-medium text-foreground">
									{scheduledRunOutcomeLabel(entry.outcome)}
								</p>
								<p class="truncate text-xs text-foreground">{scheduledRunSourceLabel(entry)}</p>
								{#if showDetail}
									<p class="break-words text-xs text-muted-foreground">{entry.message}</p>
								{/if}
								<time
									class="block text-xs text-muted-foreground"
									datetime={entry.at}
									title={formatScheduledInstant(entry.at)}
								>
									{scheduledInstantLabel(entry.at, currentTime)}
								</time>
							</div>
							{#if chatId}
								<Button
									variant="ghost"
									size="sm"
									class="h-7 shrink-0 px-2 text-xs"
									onclick={() => onOpenChat(chatId)}
								>
									{m.scheduled_prompts_open_chat()}
								</Button>
							{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="secondary" onclick={onClose}>{m.editor_actions_close()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
