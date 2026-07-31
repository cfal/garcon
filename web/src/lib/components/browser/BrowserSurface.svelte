<!--
@component
Embedded browser surface: address bar over a sandboxed cross-origin iframe.
Security contract (sandbox tokens, same-origin refusal) is documented in
BROWSER_SURFACE_DESIGN.md; change it only alongside that document.
-->
<script lang="ts">
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Globe from '@lucide/svelte/icons/globe';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import { Button } from '$lib/components/ui/button';
	import {
		BROWSER_IFRAME_SANDBOX,
		type BrowserSurfaceController,
	} from '$lib/browser/browser-surface.svelte.js';
	import { isMixedContentBlocked } from '$lib/browser/browser-url.js';
	import * as m from '$lib/paraglide/messages.js';

	let { controller }: { controller: BrowserSurfaceController } = $props();

	const rejectionMessage = $derived.by(() => {
		switch (controller.rejection) {
			case 'scheme':
				return m.browser_url_rejected_scheme();
			case 'same-origin':
				return m.browser_url_rejected_same_origin();
			case 'userinfo':
			case 'unparseable':
				return m.browser_url_rejected_invalid();
			default:
				return null;
		}
	});
	const mixedContentBlocked = $derived(
		controller.committedUrl !== null &&
			isMixedContentBlocked(controller.committedUrl, controller.appOrigin),
	);
	const embedBlocked = $derived(
		controller.embedVerdict === 'blocked' || controller.embedVerdict === 'restricted',
	);

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		controller.navigate(controller.inputValue);
	}
</script>

<div class="flex h-full min-h-0 flex-col bg-background">
	<form
		data-browser-surface-form
		class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
		onsubmit={submit}
	>
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={m.browser_back()}
			title={m.browser_back()}
			disabled={!controller.canGoBack}
			onclick={() => controller.goBack()}
		>
			<ArrowLeft class="size-3.5 rtl:-scale-x-100" />
		</Button>
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={m.browser_forward()}
			title={m.browser_forward()}
			disabled={!controller.canGoForward}
			onclick={() => controller.goForward()}
		>
			<ArrowRight class="size-3.5 rtl:-scale-x-100" />
		</Button>
		<Button
			type="button"
			variant="ghost"
			size="icon-sm"
			aria-label={m.browser_reload()}
			title={m.browser_reload()}
			disabled={controller.committedUrl === null}
			onclick={() => controller.reload()}
		>
			<RotateCw class="size-3.5" />
		</Button>
		<input
			type="text"
			class="min-w-0 flex-1 rounded-md border border-border bg-muted px-2 py-1 text-base sm:pointer-fine:text-sm text-foreground placeholder-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring outline-none"
			aria-label={m.browser_address_bar_label()}
			title={m.browser_address_shows_committed()}
			placeholder={m.browser_address_placeholder()}
			autocomplete="off"
			autocapitalize="off"
			spellcheck={false}
			enterkeyhint="go"
			bind:value={controller.inputValue}
			oninput={() => controller.clearRejection()}
		/>
		{#if controller.committedUrl}
			<Button
				variant="ghost"
				size="icon-sm"
				href={controller.committedUrl}
				target="_blank"
				rel="noopener noreferrer"
				aria-label={m.browser_open_external()}
				title={m.browser_open_external()}
			>
				<ExternalLink class="size-3.5" />
			</Button>
		{/if}
	</form>

	{#if rejectionMessage}
		<div
			class="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			role="alert"
		>
			{rejectionMessage}
		</div>
	{:else if mixedContentBlocked}
		<div
			class="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			role="alert"
		>
			{m.browser_mixed_content_blocked()}
		</div>
	{:else if embedBlocked}
		<div
			class="shrink-0 border-b border-border bg-muted px-3 py-1.5 text-xs text-muted-foreground"
			role="status"
		>
			{m.browser_embed_blocked_banner()}
		</div>
	{/if}

	{#if controller.committedUrl === null}
		<div class="grid min-h-0 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">
			<div class="max-w-md">
				<Globe class="mx-auto mb-3 size-8 opacity-50" />
				<p class="font-medium text-foreground">{m.browser_empty_state_title()}</p>
				<p class="mt-1">{m.browser_empty_state_hint()}</p>
			</div>
		</div>
	{:else}
		{#key controller.frameGeneration}
			<!-- bg-white mirrors the browser's default document canvas; framed pages
			     without their own background expect it. Not themed by design. -->
			<iframe
				data-browser-surface-frame
				title={m.browser_frame_title()}
				src={controller.committedUrl}
				sandbox={BROWSER_IFRAME_SANDBOX}
				referrerpolicy="no-referrer"
				allow="fullscreen"
				class="min-h-0 w-full flex-1 border-0 bg-white"
			></iframe>
		{/key}
	{/if}
</div>
