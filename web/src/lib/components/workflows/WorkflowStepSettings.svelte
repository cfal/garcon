<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import ComposerModelSelector from '$lib/components/model-selector/ComposerModelSelector.svelte';
	import type { ModelSelectorChange } from '$lib/components/model-selector/model-selector-types';
	import AgentSettingControl from '$lib/components/chat/composer/AgentSettingControl.svelte';
	import ChatTagEditor from '$lib/components/chat/ChatTagEditor.svelte';
	import NewChatPreambleControls from '$lib/components/preambles/NewChatPreambleControls.svelte';
	import ExecutorSelector from '$lib/components/shared/ExecutorSelector.svelte';
	import GitWorktreePickerModal from '$lib/components/git/GitWorktreePickerModal.svelte';
	import ProjectPathField from '$lib/components/project-paths/ProjectPathField.svelte';
	import {
		getChatSessions,
		getExecutors,
		getLocalSettings,
		getModelCatalog,
		getRemoteSettings,
	} from '$lib/context';
	import { nonDirectAgentIds } from '$lib/agents/direct-agents';
	import { NewChatFormState } from '$lib/chat/new-chat/new-chat-form-state.svelte';
	import {
		buildPermissionOptions,
		buildThinkingOptions,
	} from '$lib/chat/composer/composer-controls';
	import { hasChatAttachmentSupport } from '$lib/chat/composer/image-attachment.svelte';
	import { MAX_CHAT_ATTACHMENT_COUNT } from '$shared/attachments';
	import type { SessionAgentId } from '$lib/chat/sessions/chat-session-types';
	import type { WorkflowAgentStep, WorkflowCommandStep } from '$shared/workflow-definition';
	import type { JsonValue } from '$shared/json';
	import type { WorkflowLaunchContext } from '$lib/workflows/launch/workflow-locations';
	import * as m from '$lib/paraglide/messages.js';

	let {
		step,
		context,
		narrow,
		disabled,
		requireExecutor = false,
		onApply,
	}: {
		step: WorkflowAgentStep | WorkflowCommandStep;
		context: WorkflowLaunchContext | null;
		narrow: boolean;
		disabled: boolean;
		requireExecutor?: boolean;
		onApply: (fields: Readonly<Record<string, JsonValue | undefined>>) => void;
	} = $props();

	const id = $props.id();
	const executors = getExecutors();
	const rootCatalog = getModelCatalog();
	const settings = getRemoteSettings();
	const localSettings = getLocalSettings();
	const chats = getChatSessions();
	const knownTags = $derived(
		Array.from(new Set(chats.orderedChats.flatMap(({ tags }) => tags))).sort(),
	);
	let inheritExecutor = $state(untrack(() => !requireExecutor && step.executorId === undefined));
	let overridePath = $state(untrack(() => step.projectPath !== undefined));
	let shell = $state(untrack(() => (step.kind === 'command' ? (step.shell ?? '') : '')));
	let attachments = $state(
		untrack(() =>
			step.kind === 'agent' ? (step.attachments ?? []).map(({ path }) => path).join('\n') : '',
		),
	);
	let loaded = $state(false);
	let tagsOpen = $state(false);

	function agentChoices(executorId: string): readonly SessionAgentId[] {
		const catalog = rootCatalog.forExecutor(executorId);
		const ids = catalog
			.getSelectableAgents()
			.filter((agentId) => catalog.getAgent(agentId)?.executionPolicy !== 'literal');
		return localSettings.allowDirectChats ? ids : nonDirectAgentIds(ids);
	}
	const form: NewChatFormState = new NewChatFormState({
		modelCatalog: rootCatalog,
		executors,
		remoteSettings: settings,
		get selectableAgentIds() {
			return step.kind === 'agent' ? agentChoices(form.executorId) : ['shell'];
		},
	});
	const catalog = $derived(rootCatalog.forExecutor(form.executorId));
	const chosenModel = $derived({
		executorId: form.executorId,
		agentId: form.agentId,
		model: form.modelValue,
		...(form.modelSelectionTarget ?? {}),
	});
	const permission = $derived(buildPermissionOptions(form.permissionModes));
	const thinking = $derived(buildThinkingOptions(form.thinkingModes, form.modelValue));
	const filePaths = $derived(
		attachments
			.split(/\r?\n/)
			.map((path) => path.trim())
			.filter(Boolean),
	);
	const attachmentSupported = $derived(
		hasChatAttachmentSupport({
			allowImages: catalog.supportsImages(
				form.agentId,
				form.modelValue,
				form.modelSelectionTarget?.modelEndpointId,
			),
			fileMimeTypes: catalog.fileAttachmentMimeTypes(form.agentId),
		}),
	);
	const validationKey = $derived(`${form.pathContextKey}\u0000${form.nonblankPath}`);
	const eligible = $derived(
		loaded &&
			!disabled &&
			(!overridePath || form.validationStatus === 'valid') &&
			(step.kind === 'command'
				? !shell ||
					catalog
						.getModels('shell')
						.some((option) => option.value === shell || option.rawModel === shell)
				: form.executorReady &&
					form.modelCatalogValidated &&
					!form.modelSelectionPending &&
					!form.agentSelectionError &&
					!form.modelSelectionError &&
					!form.executionModeError &&
					(!filePaths.length ||
						(attachmentSupported && filePaths.length <= MAX_CHAT_ATTACHMENT_COUNT))),
	);

	onMount(() => {
		const original = step;
		const executorId = original.executorId ?? context?.executorId ?? 'local';
		const projectPath =
			original.projectPath ?? (context?.executorId === executorId ? context.cwd : '');
		let mounted = true;
		form.seedProject({ executorId, projectPath });
		void (async () => {
			await form.loadSettingsAndModels();
			if (!mounted) return;
			await rootCatalog
				.forExecutor(executorId)
				.refreshIfStale()
				.catch(() => undefined);
			if (!mounted) return;
			if (original.kind === 'agent') {
				const agentId = original.agentId ?? form.agentId;
				const pool = rootCatalog.forExecutor(executorId);
				if (
					original.model ||
					original.apiProviderId !== undefined ||
					original.modelEndpointId !== undefined
				) {
					form.selectAgent(agentId);
					const model = original.model ?? pool.getDefaultModel(agentId);
					const selection = pool.selectionFor(agentId, model, original.modelEndpointId);
					const endpoint = original.modelEndpointId
						? pool.findEndpoint(original.modelEndpointId)
						: null;
					form.restoreSelection(agentId, {
						model,
						apiProviderId:
							original.apiProviderId === undefined
								? (selection?.apiProviderId ?? null)
								: original.apiProviderId,
						modelEndpointId:
							original.modelEndpointId === undefined
								? (selection?.modelEndpointId ?? null)
								: original.modelEndpointId,
						modelProtocol: selection?.modelProtocol ?? endpoint?.endpoint.protocol ?? null,
					});
				} else if (original.agentId) {
					if (agentChoices(executorId).includes(original.agentId))
						form.selectAgent(original.agentId);
					else
						form.restoreSelection(original.agentId, {
							model: '',
							apiProviderId: null,
							modelEndpointId: null,
							modelProtocol: null,
						});
				}
				if (original.permissionMode || original.thinkingMode) {
					form.restoreExecutionModes(
						original.permissionMode ?? form.permissionMode,
						original.thinkingMode ?? form.thinkingMode,
					);
				}
				if (original.agentSettings)
					form.replaceAgentSettingsById({ [agentId]: original.agentSettings });
				form.chatTags = [...(original.tags ?? [])];
				if (original.orderedPreambleIds !== undefined)
					form.preambles.setExplicit([...original.orderedPreambleIds]);
			}
			loaded = true;
		})();
		return () => {
			mounted = false;
			form.dispose();
		};
	});

	$effect(() => {
		void validationKey;
		untrack(() => form.validateChangedPath());
	});
	$effect(() => {
		void catalog.version;
		untrack(() => form.validateAllModelsAgainstLive());
	});

	function selectModel(next: ModelSelectorChange) {
		if ((next.executorId ?? form.executorId) !== form.executorId) return;
		form.selectAgent(next.agentId);
		form.selectModel(next.modelValue, next);
	}

	function apply() {
		if (!eligible) return;
		const location = {
			executorId: inheritExecutor ? undefined : form.executorId,
			projectPath: overridePath ? form.nonblankPath : undefined,
		};
		if (step.kind === 'command') {
			onApply({ ...location, shell: shell || undefined });
			return;
		}
		const selected = form.resolvedModelSelection;
		if (!selected) return;
		const envelope = form.agentSettings;
		onApply({
			...location,
			agentId: form.agentId,
			model: selected.model,
			apiProviderId: selected.apiProviderId,
			modelEndpointId: selected.modelEndpointId,
			permissionMode: form.permissionMode,
			thinkingMode: form.thinkingMode,
			agentSettings: {
				ownerId: envelope.ownerId,
				schemaVersion: envelope.schemaVersion,
				values: envelope.values,
			},
			orderedPreambleIds: form.preambles.creationFields.orderedPreambleIds,
			attachments: filePaths.length ? filePaths.map((path) => ({ path })) : undefined,
			tags: form.chatTags.length ? [...form.chatTags] : undefined,
		});
	}
</script>

<fieldset class="space-y-3 border-t border-border pt-3" disabled={disabled || !loaded}>
	<legend class="text-sm font-semibold">{m.workflow_studio_step_settings()}</legend>
	{#if !requireExecutor}
		<label class="flex items-center gap-2 text-sm">
			<input
				type="checkbox"
				bind:checked={inheritExecutor}
				onchange={() => {
					if (inheritExecutor) {
						const executorId = context?.executorId ?? 'local';
						if (executorId !== form.executorId) {
							form.selectExecutor(executorId);
							form.projectPath = context?.cwd ?? '';
							shell = '';
						}
					}
				}}
			/>
			{m.workflow_studio_inherit_executor()}
		</label>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		<span class="wrap-anywhere text-sm text-muted-foreground"
			>{executors.label(form.executorId)}</span
		>
		<ExecutorSelector
			{executors}
			executorId={form.executorId}
			service="agents"
			disabled={inheritExecutor || !loaded}
			onSelect={(executorId) => {
				form.selectExecutor(executorId);
				form.projectPath = context?.executorId === executorId ? context.cwd : '';
				shell = '';
			}}
		/>
	</div>
	<label class="flex items-center gap-2 text-sm">
		<input type="checkbox" bind:checked={overridePath} />
		{m.workflow_studio_override_folder()}
	</label>
	{#if overridePath}
		<div class="space-y-1">
			<label for={`${id}-path`} class="block text-sm">{m.chat_new_chat_project_path()}</label>
			<ProjectPathField
				id={`${id}-path`}
				bind:value={form.projectPath}
				validationStatus={form.validationStatus}
				validationError={form.validationError}
				browser={{
					open: form.showBrowser && form.filesAvailable,
					executorId: form.executorId,
					executorContextKey: form.pathContextKey,
					currentPath: form.nonblankPath || form.browseStartPath || form.projectBasePath,
					basePath: form.projectBasePath,
					isMobile: narrow,
					onSelect: (path) => form.selectProjectPath(path),
					onClose: () => (form.showBrowser = false),
					button: {
						label: m.workflow_studio_browse_folder(),
						disabled: !form.filesAvailable,
						onclick: () => (form.showBrowser = !form.showBrowser),
					},
				}}
				feedback={{
					error: form.validationError,
					worktree:
						form.gitAvailable && form.gitRepoStatus === 'git'
							? { disabled: false, onOpen: () => form.worktreePicker.open() }
							: undefined,
				}}
			/>
		</div>
	{/if}
	{#if step.kind === 'command'}
		<label class="block space-y-1 text-sm">
			<span>{m.workflow_studio_shell()}</span>
			<select class="workflow-field" bind:value={shell}>
				<option value="">{m.workflow_studio_executor_default()}</option>
				{#if shell && !catalog
						.getModels('shell')
						.some((entry) => (entry.rawModel ?? entry.value) === shell)}
					<option value={shell}>{shell} · {m.common_unavailable()}</option>
				{/if}
				{#each catalog.getModels('shell') as entry (entry.value)}
					<option value={entry.rawModel ?? entry.value}>{entry.label}</option>
				{/each}
			</select>
		</label>
	{:else}
		<ComposerModelSelector
			value={chosenModel}
			mode={{ agent: 'select', source: 'select', surface: 'composer' }}
			getSelectableAgentIds={agentChoices}
			onChange={selectModel}
		/>
		<div class="grid gap-2">
			{#if permission.length}
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_permissions()}</span>
					<select
						class="workflow-field"
						value={form.permissionMode}
						onchange={(event) => {
							const mode = permission.find(({ value }) => value === event.currentTarget.value);
							if (mode) form.setPermissionMode(mode.value);
						}}
					>
						{#each permission as option (option.value)}<option value={option.value}
								>{option.label}</option
							>{/each}
					</select>
				</label>
			{/if}
			{#if thinking.length}
				<label class="block space-y-1 text-sm">
					<span>{m.workflow_studio_thinking()}</span>
					<select
						class="workflow-field"
						value={form.thinkingMode}
						onchange={(event) => {
							const mode = thinking.find(({ value }) => value === event.currentTarget.value);
							if (mode) form.setThinkingMode(mode.value);
						}}
					>
						{#each thinking as option (option.value)}<option value={option.value}
								>{option.label}</option
							>{/each}
					</select>
				</label>
			{/if}
		</div>
		<div class="flex flex-wrap gap-2">
			{#each form.agentSettingDescriptors as descriptor (descriptor.key)}
				<svelte:boundary>
					<AgentSettingControl
						{descriptor}
						settings={{
							descriptors: form.agentSettingDescriptors,
							envelope: form.agentSettings,
							defaults: catalog.getDefaultAgentSettings(form.agentId),
							onChange: (setting, value) => form.setAgentSetting(setting, value),
						}}
						placement="inline"
						align="start"
						side="bottom"
						disabled={disabled || !loaded}
					/>
					{#snippet failed()}{/snippet}
				</svelte:boundary>
			{/each}
			<Button
				variant="outline"
				size="sm"
				aria-expanded={tagsOpen}
				onclick={() => (tagsOpen = !tagsOpen)}>{m.workflow_studio_tags()}</Button
			>
		</div>
		<ChatTagEditor
			tags={form.chatTags}
			{knownTags}
			open={tagsOpen}
			onAdd={(tag) => form.addTag(tag)}
			onRemove={(tag) => form.removeTag(tag)}
			onClose={() => (tagsOpen = false)}
		/>
		<NewChatPreambleControls
			selection={form.preambles}
			nonblankPath={form.nonblankPath}
			validationStatus={form.validationStatus}
			onClear={() => form.preambles.setExplicit([])}
		/>
		{#if attachmentSupported || filePaths.length}
			<label class="block space-y-1 text-sm">
				<span>{m.workflow_studio_attachment_paths()}</span>
				<textarea
					class="workflow-field min-h-16 font-mono"
					spellcheck={false}
					bind:value={attachments}></textarea>
			</label>
			{#if filePaths.length && (!attachmentSupported || filePaths.length > MAX_CHAT_ATTACHMENT_COUNT)}
				<p role="alert" class="text-sm text-destructive">
					{m.workflow_studio_attachment_unavailable({ limit: MAX_CHAT_ATTACHMENT_COUNT })}
				</p>
			{/if}
		{/if}
		{#if loaded && (form.agentSelectionError || form.modelSelectionError || form.executionModeError)}
			<p role="status" class="wrap-anywhere text-sm text-destructive">
				{form.agentSelectionError ?? form.modelSelectionError ?? form.executionModeError}
			</p>
		{/if}
	{/if}
	{#if !loaded}<p role="status" class="text-sm text-muted-foreground">
			{m.chat_new_chat_errors_defaults_loading()}
		</p>{/if}
	<Button variant="outline" size="sm" disabled={!eligible} onclick={apply}
		>{m.workflow_studio_apply_settings()}</Button
	>
</fieldset>

{#if form.worktreePicker.isOpen}
	<GitWorktreePickerModal session={form.worktreePicker} />
{/if}
