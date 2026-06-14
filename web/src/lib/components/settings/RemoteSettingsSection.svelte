<!-- Server-stored settings. Shows a loading state until remote settings
     are available; never renders guessed defaults. -->
<script lang="ts">
	import { Switch } from '$lib/components/ui/switch/index.js';
	import { getRemoteSettings, getModelCatalog } from '$lib/context';
	import type { SessionAgentId } from '$lib/types/app';
	import type { PinnedInsertPosition } from '$lib/types/session.js';
	import type { ApiProtocol } from '$shared/api-providers';
	import * as m from '$lib/paraglide/messages.js';
	import SettingsModelSelector from '$lib/components/model-selector/SettingsModelSelector.svelte';
	import TelegramSettingsPanel from './TelegramSettingsPanel.svelte';
	import type {
		ModelSelectorChange,
		ModelSelectorMode,
		ModelSelectorValue,
	} from '$lib/components/model-selector/model-selector-types';

	const remoteSettings = getRemoteSettings();
	const modelCatalog = getModelCatalog();

	let saveError = $state<string | null>(null);
	let titleSelectionOverride = $state<ModelSelectorValue | null>(null);
	let titleSelectionSaveToken = 0;

	// Chat title generation local editing state (hydrated from snapshot).
	let titleEnabled = $derived(remoteSettings.snapshot?.uiEffective?.chatTitle?.enabled !== false);
	let titleProvider = $derived<SessionAgentId>(
		titleSelectionOverride?.agentId ??
			(remoteSettings.snapshot?.uiEffective?.chatTitle?.agentId as SessionAgentId) ??
			'claude',
	);
	let titleModel = $derived(
		titleSelectionOverride?.model ?? remoteSettings.snapshot?.uiEffective?.chatTitle?.model ?? '',
	);
	let titleModelEndpointId = $derived(
		titleSelectionOverride?.modelEndpointId ??
			remoteSettings.snapshot?.uiEffective?.chatTitle?.modelEndpointId ??
			null,
	);
	let titleModelProtocol = $derived<ApiProtocol | null>(
		titleSelectionOverride?.modelProtocol ??
			remoteSettings.snapshot?.uiEffective?.chatTitle?.modelProtocol ??
			null,
	);
	const titleSelectorMode: ModelSelectorMode = {
		agent: 'select',
		source: 'select',
		surface: 'settings',
	};
	const titleSelectorValue = $derived({
		agentId: titleProvider,
		model: titleModel,
		modelEndpointId: titleModelEndpointId,
		modelProtocol: titleModelProtocol,
	});

	async function save(patch: Record<string, unknown>): Promise<boolean> {
		saveError = null;
		try {
			await remoteSettings.update({ ui: patch });
			return true;
		} catch (error) {
			saveError = error instanceof Error ? error.message : m.settings_save_failed();
			return false;
		}
	}

	async function onPinnedInsertPositionChange(next: PinnedInsertPosition) {
		await save({ pinnedInsertPosition: next });
	}

	async function persistChatTitleSettings(overrides?: Record<string, unknown>) {
		const base = remoteSettings.snapshot?.ui?.chatTitle ?? {};
		const nextProvider =
			typeof overrides?.agentId === 'string'
				? (overrides.agentId as SessionAgentId)
				: titleProvider;
		const nextModelInput =
			typeof overrides?.model === 'string'
				? overrides.model
				: modelCatalog.selectionValueFor(nextProvider, titleModel, titleModelEndpointId);
		const selection = modelCatalog.selectionFor(nextProvider, nextModelInput, titleModelEndpointId);
		await save({
			chatTitle: {
				...base,
				enabled: titleEnabled,
				...overrides,
				agentId: nextProvider,
				model: selection.model,
				apiProviderId: selection.apiProviderId,
				modelEndpointId: selection.modelEndpointId,
				modelProtocol: selection.modelProtocol,
			},
		});
	}

	async function persistChatTitleSelection(next: ModelSelectorChange) {
		const base = remoteSettings.snapshot?.ui?.chatTitle ?? {};
		const previousOverride = titleSelectionOverride;
		const token = ++titleSelectionSaveToken;
		titleSelectionOverride = {
			agentId: next.agentId,
			model: next.modelValue,
			apiProviderId: next.apiProviderId,
			modelEndpointId: next.modelEndpointId,
			modelProtocol: next.modelProtocol,
		};

		const saved = await save({
			chatTitle: {
				...base,
				enabled: titleEnabled,
				agentId: next.agentId,
				model: next.model,
				apiProviderId: next.apiProviderId,
				modelEndpointId: next.modelEndpointId,
				modelProtocol: next.modelProtocol,
			},
		});
		if (token !== titleSelectionSaveToken) return;
		titleSelectionOverride = saved ? null : previousOverride;
	}
</script>

<div class="space-y-3">
	{#if !remoteSettings.hasSnapshot}
		<div class="py-12 flex items-center justify-center text-muted-foreground">
			{m.status_loading()}
		</div>
	{:else}
		{#if saveError}
			<div
				class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
			>
				{saveError}
			</div>
		{/if}

		<div class="bg-muted/50 border border-border rounded-lg">
			<div class="flex items-center justify-between px-4 py-2">
				<div class="text-sm font-medium text-foreground">
					{m.sidebar_chats_pinned_insert_position()}
				</div>
				<select
					class="text-sm bg-muted border border-border rounded-md px-2 py-1 text-foreground"
					aria-label={m.sidebar_chats_pinned_insert_position()}
					value={remoteSettings.snapshot?.ui.pinnedInsertPosition ?? 'top'}
					onchange={(e) =>
						onPinnedInsertPositionChange(
							(e.currentTarget as HTMLSelectElement).value as PinnedInsertPosition,
						)}
				>
					<option value="top">{m.sidebar_chats_pinned_insert_top()}</option>
					<option value="bottom">{m.sidebar_chats_pinned_insert_bottom()}</option>
				</select>
			</div>
		</div>

		<!-- Chat title generation -->
		<div class="bg-muted/50 border border-border rounded-lg px-4">
			<div class="flex items-center justify-between py-2">
				<div class="text-sm font-medium text-foreground">{m.settings_chat_generate_titles()}</div>
				<Switch
					checked={titleEnabled}
					onCheckedChange={async (next) => {
						await persistChatTitleSettings({ enabled: Boolean(next) });
					}}
					aria-label={m.settings_chat_generate_titles()}
				/>
			</div>

			{#if titleEnabled}
				<div class="flex items-center justify-between py-2">
					<div class="text-sm font-medium text-foreground">{m.settings_chat_title_model()}</div>
					<SettingsModelSelector
						value={titleSelectorValue}
						mode={titleSelectorMode}
						onChange={persistChatTitleSelection}
						align="end"
						side="bottom"
					/>
				</div>
			{/if}
		</div>

		<TelegramSettingsPanel />
	{/if}
</div>
