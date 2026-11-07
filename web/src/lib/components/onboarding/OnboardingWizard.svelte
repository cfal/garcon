<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Switch } from '$lib/components/ui/switch/index.js';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import FileTextIcon from '@lucide/svelte/icons/file-text';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import { getAppShell, getLocalSettings } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { cn } from '$lib/utils/cn.js';
	import type { ChatMaxWidth } from '$lib/stores/local-settings.svelte.js';
	import {
		OnboardingWizardState,
		type OnboardingPageId,
	} from './onboarding-wizard-state.svelte.js';
	import { ONBOARDING_OPTION_CARD_CLASS } from './onboarding-option-card.js';
	import OnboardingSidebarPage from './OnboardingSidebarPage.svelte';
	import OnboardingWritingPage from './OnboardingWritingPage.svelte';
	import OnboardingThemePage from './OnboardingThemePage.svelte';
	import OnboardingWelcomePage from './OnboardingWelcomePage.svelte';

	const appShell = getAppShell();
	const ls = getLocalSettings();
	const wizard = new OnboardingWizardState({
		localSettings: ls,
		onClose: () => appShell.closeOnboardingWizard(),
		onOpenProviders: () => appShell.openSettings('providers'),
		onOpenScheduledPrompts: () => appShell.openScheduledPrompts(),
		onOpenPreambles: () => appShell.openPreambles(),
	});

	function handleOpenChange(open: boolean) {
		if (!open) wizard.finish();
	}

	let pageTitleElement = $state<HTMLElement | null>(null);
	let pageBodyElement = $state<HTMLDivElement | null>(null);
	let dialogElement = $state<HTMLDivElement | null>(null);

	function handleOpenAutoFocus(event: Event): void {
		event.preventDefault();
		pageTitleElement?.focus();
	}

	// Moves focus to the page heading on each step change so assistive
	// technology announces the new page; focus otherwise stays on Continue.
	$effect(() => {
		wizard.pageIndex;
		if (dialogElement) dialogElement.scrollTop = 0;
		if (pageBodyElement) pageBodyElement.scrollTop = 0;
		pageTitleElement?.focus();
	});

	const pageText: Record<OnboardingPageId, { title: () => string; description: () => string }> = {
		welcome: { title: m.onboarding_welcome_title, description: m.onboarding_welcome_description },
		theme: { title: m.onboarding_theme_title, description: m.onboarding_theme_description },
		'chat-layout': {
			title: m.onboarding_layout_title,
			description: m.onboarding_layout_description,
		},
		'chat-display': {
			title: m.onboarding_chat_display_title,
			description: m.onboarding_chat_display_description,
		},
		writing: { title: m.onboarding_writing_title, description: m.onboarding_writing_description },
		done: { title: m.onboarding_done_title, description: m.onboarding_done_description },
	};

	const chatMaxWidthOptions: Array<{
		value: ChatMaxWidth;
		label: () => string;
		previewClass: string;
	}> = [
		{ value: 'none', label: m.settings_chat_max_width_none, previewClass: 'w-full' },
		{ value: 'large', label: m.settings_chat_max_width_large, previewClass: 'w-4/5' },
		{ value: 'medium', label: m.settings_chat_max_width_medium, previewClass: 'w-3/5' },
		{ value: 'small', label: m.settings_chat_max_width_small, previewClass: 'w-2/5' },
	];
</script>

<Dialog.Root open={appShell.showOnboardingWizard} onOpenChange={handleOpenChange}>
	<Dialog.Content
		bind:ref={dialogElement}
		class="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl [@media(max-height:30rem)]:block [@media(max-height:30rem)]:overflow-y-auto"
		aria-describedby="onboarding-description"
		onOpenAutoFocus={handleOpenAutoFocus}
	>
		<Dialog.Header class="shrink-0 px-6 pt-6 pb-4 text-left">
			<div class="flex items-center justify-between gap-3 pr-6 text-xs text-muted-foreground">
				<p class="font-medium">{m.onboarding_wizard_title()}</p>
				<span aria-live="polite" aria-atomic="true">
					{m.onboarding_step_label({ current: wizard.pageIndex + 1, total: wizard.pageCount })}
				</span>
			</div>
			<Dialog.Title
				bind:ref={pageTitleElement}
				tabindex={-1}
				class="text-xl font-semibold outline-none">{pageText[wizard.pageId].title()}</Dialog.Title
			>
			<Dialog.Description id="onboarding-description">
				{pageText[wizard.pageId].description()}
			</Dialog.Description>
		</Dialog.Header>

		<div
			bind:this={pageBodyElement}
			class="relative min-h-0 flex-auto overflow-y-auto px-6 pt-2 pb-6 [@media(max-height:30rem)]:overflow-visible"
		>
			{#if wizard.pageId === 'welcome'}
				<OnboardingWelcomePage />
			{:else if wizard.pageId === 'theme'}
				<OnboardingThemePage onSelect={(preference) => ls.set('themePreference', preference)} />
			{:else if wizard.pageId === 'chat-layout'}
				<OnboardingSidebarPage />
			{:else if wizard.pageId === 'chat-display'}
				<fieldset>
					<legend class="mb-2 text-sm font-medium text-foreground">
						{m.settings_chat_max_width()}
					</legend>
					<div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
						{#each chatMaxWidthOptions as option (option.value)}
							<label class={cn(ONBOARDING_OPTION_CARD_CLASS, 'gap-1.5 p-2')}>
								<input
									type="radio"
									class="sr-only"
									name="onboarding-chat-max-width"
									value={option.value}
									checked={ls.chatMaxWidth === option.value}
									onchange={() => ls.set('chatMaxWidth', option.value)}
								/>
								<span
									class="flex h-8 w-full items-center justify-center rounded-md bg-muted/60 px-1"
									aria-hidden="true"
								>
									<span class={cn('h-3 rounded-xs bg-muted-foreground/50', option.previewClass)}
									></span>
								</span>
								<span class="text-xs font-medium text-foreground">{option.label()}</span>
							</label>
						{/each}
					</div>
				</fieldset>
				<div class="mt-3 rounded-lg border border-border bg-muted/50 px-4">
					<div class="flex items-center justify-between gap-4 py-2">
						<span class="text-sm font-medium text-foreground">
							{m.settings_chat_show_thinking()}
						</span>
						<Switch
							checked={ls.showThinking}
							onCheckedChange={() => ls.toggle('showThinking')}
							aria-label={m.settings_chat_show_thinking()}
						/>
					</div>
					<div class="flex items-center justify-between gap-4 py-2">
						<span class="text-sm font-medium text-foreground">
							{m.settings_chat_combine_tool_use_messages()}
						</span>
						<Switch
							checked={ls.combineToolUseMessages}
							onCheckedChange={(checked) => ls.set('combineToolUseMessages', checked)}
							aria-label={m.settings_chat_combine_tool_use_messages()}
						/>
					</div>
					<div class="flex items-center justify-between gap-4 py-2">
						<span class="text-sm font-medium text-foreground">
							{m.settings_chat_auto_expand_tools()}
						</span>
						<Switch
							checked={ls.autoExpandTools}
							onCheckedChange={() => ls.toggle('autoExpandTools')}
							aria-label={m.settings_chat_auto_expand_tools()}
						/>
					</div>
				</div>
			{:else if wizard.pageId === 'writing'}
				<OnboardingWritingPage />
			{:else}
				<div class="divide-y divide-border">
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-md px-2 py-4 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
						onclick={() => wizard.finishToScheduledPrompts()}
						aria-labelledby="onboarding-scheduled-title"
						aria-describedby="onboarding-scheduled-description"
					>
						<CalendarClockIcon class="size-5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1">
							<span id="onboarding-scheduled-title" class="block text-sm font-medium"
								>{m.onboarding_scheduled_tasks()}</span
							>
							<span
								id="onboarding-scheduled-description"
								class="mt-1 block text-sm text-muted-foreground"
							>
								{m.onboarding_scheduled_tasks_description()}
							</span>
						</span>
						<ArrowRightIcon class="size-4 shrink-0 text-muted-foreground" />
					</button>
					<button
						type="button"
						class="flex w-full items-center gap-3 rounded-md px-2 py-4 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
						onclick={() => wizard.finishToPreambles()}
						aria-labelledby="onboarding-preambles-title"
						aria-describedby="onboarding-preambles-description"
					>
						<FileTextIcon class="size-5 shrink-0 text-muted-foreground" />
						<span class="min-w-0 flex-1">
							<span id="onboarding-preambles-title" class="block text-sm font-medium"
								>{m.preambles_title()}</span
							>
							<span
								id="onboarding-preambles-description"
								class="mt-1 block text-sm text-muted-foreground"
							>
								{m.onboarding_preambles_description()}
							</span>
						</span>
						<ArrowRightIcon class="size-4 shrink-0 text-muted-foreground" />
					</button>
				</div>
			{/if}
		</div>

		<Dialog.Footer
			class="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-t border-border px-4 py-4 sm:px-6"
		>
			<Button variant="ghost" onclick={() => wizard.back()} disabled={wizard.isFirstPage}>
				{m.onboarding_back()}
			</Button>
			{#if wizard.isDonePage}
				<Button
					class="h-auto min-h-9 min-w-0 justify-self-end whitespace-normal py-2"
					onclick={() => wizard.finishToProviders()}
				>
					{m.onboarding_done_providers()}
				</Button>
			{:else}
				<Button class="justify-self-end" onclick={() => wizard.advance()}
					>{m.onboarding_continue()}</Button
				>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
