<script lang="ts">
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { getSharedChat } from '$lib/api/shares.js';
	import { parseChatMessage } from '$shared/chat-types';
	import type { ChatMessage } from '$shared/chat-types';
	import {
		UserMessage,
		AssistantMessage,
		ThinkingMessage,
		ErrorMessage,
		isToolUseMessage,
	} from '$shared/chat-types';
	import Markdown from '$lib/components/chat/Markdown.svelte';
	import ChatToolEventRenderer from '$lib/components/chat/tools/ChatToolEventRenderer.svelte';
	import ChatEventCard from '$lib/components/chat/rows/ChatEventCard.svelte';
	import { ChevronRight } from '@lucide/svelte';
	import Loader2 from '@lucide/svelte/icons/loader-2';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
	import * as m from '$lib/paraglide/messages.js';

	let messages = $state<ChatMessage[]>([]);
	let title = $state('');
	let provider = $state('');
	let sharedAt = $state('');
	let isLoading = $state(true);
	let errorMsg = $state<string | null>(null);
	let thinkingStates = $state<Record<number, boolean>>({});

	// Applies dark mode based on system preference.
	onMount(() => {
		const mql = window.matchMedia('(prefers-color-scheme: dark)');
		document.documentElement.classList.toggle('dark', mql.matches);
		document.documentElement.style.colorScheme = mql.matches ? 'dark' : 'light';
		function onChange(e: MediaQueryListEvent) {
			document.documentElement.classList.toggle('dark', e.matches);
			document.documentElement.style.colorScheme = e.matches ? 'dark' : 'light';
		}
		mql.addEventListener('change', onChange);
		return () => mql.removeEventListener('change', onChange);
	});

	onMount(async () => {
		const token = page.params.token;
		if (!token) {
			errorMsg = m.shared_view_not_found();
			isLoading = false;
			return;
		}

		try {
			const resp = await getSharedChat(token);
			const snapshot = resp.snapshot;
			title = snapshot.title;
			provider = snapshot.provider;
			sharedAt = snapshot.sharedAt;
			messages = (snapshot.messages ?? [])
				.map((raw: unknown) => {
					try { return parseChatMessage(raw as Record<string, unknown>); }
					catch { return null; }
				})
				.filter((msg): msg is ChatMessage => msg !== null);
		} catch {
			errorMsg = m.shared_view_not_found();
		} finally {
			isLoading = false;
		}
	});

	function formattedSharedDate(): string {
		if (!sharedAt) return '';
		return m.shared_view_shared_on({ date: new Date(sharedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) });
	}

	function toggleThinking(idx: number) {
		thinkingStates[idx] = !thinkingStates[idx];
	}

	function isGroupedWith(prev: ChatMessage | null, current: ChatMessage): boolean {
		if (!prev) return false;
		const prevCategory = prev instanceof AssistantMessage ? 'assistant' : prev.type;
		const curCategory = current instanceof AssistantMessage ? 'assistant' : current.type;
		return prevCategory === curCategory;
	}
</script>

<svelte:head>
	<title>{title || m.shared_view_title()} - Garcon</title>
</svelte:head>

<div class="min-h-dvh bg-background text-foreground">
	<!-- Header -->
	<header class="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
		<div class="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
			<div class="w-8 h-8 bg-primary rounded-lg flex items-center justify-center flex-shrink-0">
				<MessageSquare class="w-4 h-4 text-primary-foreground" />
			</div>
			<div class="min-w-0 flex-1">
				{#if title}
					<h1 class="text-sm font-semibold text-foreground truncate">{title}</h1>
				{:else}
					<h1 class="text-sm font-semibold text-foreground">{m.shared_view_title()}</h1>
				{/if}
				{#if sharedAt}
					<p class="text-xs text-muted-foreground">{formattedSharedDate()}</p>
				{/if}
			</div>
			{#if provider}
				<span class="text-xs px-2 py-0.5 rounded-full border bg-muted text-muted-foreground capitalize flex-shrink-0">
					{provider}
				</span>
			{/if}
		</div>
	</header>

	<!-- Content -->
	<main class="max-w-4xl mx-auto px-4 py-6">
		{#if isLoading}
			<div class="flex items-center justify-center py-16 gap-2 text-muted-foreground">
				<Loader2 class="w-5 h-5 animate-spin" />
				<span>{m.shared_view_loading()}</span>
			</div>
		{:else if errorMsg}
			<div class="flex flex-col items-center justify-center py-16 gap-4">
				<div class="w-16 h-16 bg-muted rounded-full flex items-center justify-center">
					<AlertTriangle class="w-8 h-8 text-muted-foreground" />
				</div>
				<div class="text-center">
					<h2 class="text-lg font-semibold text-foreground mb-1">{m.shared_view_not_found_title()}</h2>
					<p class="text-sm text-muted-foreground max-w-md">{errorMsg}</p>
				</div>
				<a href="/" class="text-sm text-primary hover:underline">{m.shared_view_back_to_app()}</a>
			</div>
		{:else}
			<div class="space-y-1">
				{#each messages as message, idx}
					{@const prevMessage = idx > 0 ? messages[idx - 1] : null}
					{@const isGrouped = isGroupedWith(prevMessage, message)}
					<svelte:boundary>
						{#snippet failed()}
							<div class="text-xs text-muted-foreground p-2">Failed to render message</div>
						{/snippet}
						<div class="chat-message {message instanceof UserMessage ? 'flex justify-start' : ''} {isGrouped ? '' : 'mt-3'}">
							{#if message instanceof UserMessage}
								<div class="sm:max-w-[85%] min-w-0">
									<div class="mt-1 bg-user-bubble text-user-bubble-foreground rounded-2xl rounded-bl-md px-4 py-2 shadow-sm">
										<div class="text-sm">
											<Markdown source={message.content} variant="user" />
										</div>
										{#if message.images && message.images.length > 0}
											<div class="mt-2 grid grid-cols-2 gap-2">
												{#each message.images as img, imgIdx (img.name || imgIdx)}
													<img src={img.data} alt={img.name} class="rounded-lg max-w-full h-auto" />
												{/each}
											</div>
										{/if}
										<div class="mt-1 text-xs text-user-bubble-timestamp">
											{new Date(message.timestamp).toLocaleTimeString()}
										</div>
									</div>
								</div>
							{:else if message instanceof AssistantMessage}
								<div class="text-sm text-foreground">
									<Markdown source={String(message.content || '')} variant="assistant" />
								</div>
							{:else if message instanceof ThinkingMessage}
								<ChatEventCard variant="thinking" compact>
									{#snippet body()}
										<button
											type="button"
											class="flex w-full items-center gap-2 text-left cursor-pointer"
											onclick={() => toggleThinking(idx)}
											aria-expanded={thinkingStates[idx] ?? true}
										>
											<span class="text-xs font-medium text-muted-foreground">{m.chat_message_thinking()}</span>
											<ChevronRight class="ml-auto w-3 h-3 transition-transform {(thinkingStates[idx] ?? true) ? 'rotate-90' : ''}" />
										</button>
										{#if thinkingStates[idx] ?? true}
											<div class="mt-0.5 text-sm text-foreground/90">
												<Markdown source={message.content} variant="thinking" />
											</div>
										{/if}
									{/snippet}
								</ChatEventCard>
							{:else if isToolUseMessage(message)}
								<ChatToolEventRenderer
									toolMessage={message}
									mode="input"
									autoExpandTools={false}
								/>
							{:else if message instanceof ErrorMessage}
								<ChatEventCard variant="error">
									{#snippet body()}
										<div class="text-sm whitespace-pre-wrap break-words">{message.content}</div>
									{/snippet}
								</ChatEventCard>
							{/if}
						</div>
					</svelte:boundary>
				{/each}
			</div>
		{/if}
	</main>
</div>
