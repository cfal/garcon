<script lang="ts">
	import type { BashToolUseMessage } from '$shared/chat-types'
	import ChatEventCard from '../rows/ChatEventCard.svelte'
	import { copyToClipboard } from '$lib/utils/clipboard'
	import Copy from '@lucide/svelte/icons/copy'
	import Check from '@lucide/svelte/icons/check'

	interface Props {
		messages: BashToolUseMessage[]
	}

	let { messages }: Props = $props()

	let copied = $state(false)
	const commandCount = $derived(messages.length)
	const commandLabel = $derived(`${commandCount} ${commandCount === 1 ? 'command' : 'commands'}`)
	const combinedCommands = $derived(messages.map((message) => message.command).join('\n'))

	async function copyCommands() {
		if (!combinedCommands) return
		const didCopy = await copyToClipboard(combinedCommands)
		if (!didCopy) return
		copied = true
		setTimeout(() => {
			copied = false
		}, 2000)
	}
</script>

<div class="group my-0.5">
	<ChatEventCard variant="default" compact>
		{#snippet body()}
			<div class="mb-1.5 flex items-center gap-2 min-w-0">
				<span class="text-[11px] font-medium text-muted-foreground tracking-wide">Bash</span>
				<span class="text-[11px] text-muted-foreground">{commandLabel}</span>
				<button
					type="button"
					onclick={copyCommands}
					class="ml-auto inline-flex size-5 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground opacity-100 transition-opacity focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [@media(hover:hover)_and_(pointer:fine)]:opacity-0 [@media(hover:hover)_and_(pointer:fine)]:group-hover:opacity-100 [@media(hover:hover)_and_(pointer:fine)]:group-focus-within:opacity-100"
					title="Copy commands"
					aria-label="Copy commands"
				>
					{#if copied}
						<Check class="size-3 text-status-success-foreground" />
					{:else}
						<Copy class="size-3" />
					{/if}
				</button>
			</div>

			<div class="divide-y divide-border/70">
				{#each messages as message (message.toolId)}
					<div class="py-1 first:pt-0 last:pb-0">
						<code class="block whitespace-pre-wrap break-all text-xs text-foreground font-mono">
							{message.command}
						</code>
						{#if message.description}
							<div class="mt-0.5 text-[11px] text-muted-foreground italic">
								{message.description}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/snippet}
	</ChatEventCard>
</div>
