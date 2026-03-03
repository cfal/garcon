<script lang="ts">
	import {
		MODE_STYLES,
		DEFAULT_MODE_STYLE,
		MODE_LABELS,
		THINKING_MODES
	} from '$lib/chat/provider-state.svelte';
	import { getProviderState, getChatSessions, getPreferences, getModelCatalog } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';
	import { Lightbulb, ImagePlus } from '@lucide/svelte';
	import type { PermissionMode } from '$lib/types/chat';

	interface Props {
		onModelChange?: (model: string) => void;
		onPermissionModeChange?: (mode: PermissionMode) => void;
		onThinkingModeChange?: (mode: string) => void;
		onAttachImages?: () => void;
	}

	let { onModelChange, onPermissionModeChange, onThinkingModeChange, onAttachImages }: Props = $props();

	const providerState = getProviderState();
	const sessions = getChatSessions();
	const preferences = getPreferences();
	const modelCatalog = getModelCatalog();

	// Maps thinking mode IDs to display-friendly keys.
	const MODE_KEY_MAP: Record<string, string> = {
		'think-hard': 'Think Hard',
		'think-harder': 'Think Harder'
	};

	const thinkingModeName = $derived.by(() => {
		const mode = THINKING_MODES.find((m) => m.id === providerState.thinkingMode) || THINKING_MODES[0];
		return MODE_KEY_MAP[mode.id] || mode.name;
	});

	const modeStyle = $derived(MODE_STYLES[providerState.permissionMode] || DEFAULT_MODE_STYLE);
	const modeLabel = $derived(MODE_LABELS[providerState.permissionMode] || 'Default');

	function cycleModel() {
		const provider = providerState.provider;
		const models = modelCatalog.getModels(provider);
		if (models.length === 0) return;
		const idx = models.findIndex((m) => m.value === providerState.model);
		const next = models[(idx + 1) % models.length];
		providerState.setModel(next.value);
		onModelChange?.(next.value);
		const prefKey = provider === 'claude' ? 'claudeModel'
			: provider === 'codex' ? 'codexModel' : 'opencodeModel';
		preferences.setPreference(prefKey, next.value);
	}
</script>

<div class="flex items-center justify-center gap-2 sm:gap-3 py-1.5 px-3 bg-muted/30 border-t border-b border-border overflow-x-auto scrollbar-hide">
	<!-- Model selector -->
	<button
		type="button"
		onclick={cycleModel}
		class="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 {DEFAULT_MODE_STYLE.button}"
		title="Click to change model"
	>
		<span class="truncate">{providerState.model}</span>
	</button>

	<!-- Permission mode cycle -->
	<button
		type="button"
		onclick={() => {
			providerState.cyclePermissionMode();
			onPermissionModeChange?.(providerState.permissionMode);
		}}
		class="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 max-w-[10rem] sm:max-w-none {modeStyle.button}"
		title="Click to change permission mode"
	>
		<div class="flex items-center gap-2 min-w-0">
			<div class="w-2 h-2 rounded-full flex-shrink-0 {modeStyle.dot}"></div>
			<span class="truncate">{modeLabel}</span>
		</div>
	</button>

	<!-- Thinking mode cycle -->
	<button
		type="button"
		onclick={() => {
			providerState.cycleThinkingMode();
			onThinkingModeChange?.(providerState.thinkingMode);
		}}
		class="px-3 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200 {providerState.thinkingMode === 'none' ? MODE_STYLES.default.button : DEFAULT_MODE_STYLE.button}"
		title="Thinking mode: {thinkingModeName}"
		>
			<span class="flex items-center gap-1.5">
				<Lightbulb class="w-4 h-4" />
				{thinkingModeName}
			</span>
		</button>

		<button
			type="button"
			onclick={onAttachImages}
			class="px-3 py-1.5 text-muted-foreground hover:text-foreground rounded-lg border border-border flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background"
			title={m.chat_composer_attach_images()}
		>
			<ImagePlus class="w-4 h-4" />
		</button>
</div>
