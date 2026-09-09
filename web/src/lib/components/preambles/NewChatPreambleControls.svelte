<script lang="ts">
	import { untrack } from 'svelte';
	import type { PathValidationStatus } from '$lib/chat/new-chat/new-chat-submit.js';
	import type { NewChatPreambleSelectionState } from '$lib/preambles/new-chat-preamble-selection-state.svelte.js';
	import { getPreambles } from '$lib/context';
	import NewChatPreamblePicker from './NewChatPreamblePicker.svelte';
	import NewChatPreambleSummary from './NewChatPreambleSummary.svelte';

	interface Props {
		selection: NewChatPreambleSelectionState;
		trimmedPath: string;
		validationStatus: PathValidationStatus;
		pickerDescription?: string;
		summaryReadyLabel?: string;
		summaryEmptyLabel?: string;
		onClear?: () => void;
		onOpenCatalog?: (returnFocus: () => void) => void;
	}

	let {
		selection,
		trimmedPath,
		validationStatus,
		pickerDescription,
		summaryReadyLabel,
		summaryEmptyLabel,
		onClear,
		onOpenCatalog,
	}: Props = $props();
	const preamblesCatalog = getPreambles();
	let pickerOpen = $state(false);
	let observedSelection: NewChatPreambleSelectionState | null = null;
	let observedPreambleCatalogRevision: number | null = null;
	let refreshedPreambleCatalogRevision: number | null = null;
	let observedPreambleInvalidationVersion: number | null = null;

	const summaryLoading = $derived(
		trimmedPath.length > 0 &&
			(validationStatus === 'idle' || validationStatus === 'checking' || selection.previewLoading),
	);

	$effect(() => {
		const activeSelection = selection;
		untrack(() => {
			if (activeSelection === observedSelection) return;
			observedSelection = activeSelection;
			observedPreambleCatalogRevision = null;
			refreshedPreambleCatalogRevision = null;
			observedPreambleInvalidationVersion = preamblesCatalog.invalidationVersion;
			pickerOpen = false;
		});
	});

	// Keeps the preview at or ahead of the loaded catalog without refetching its first match.
	$effect(() => {
		const activeSelection = selection;
		const revision = preamblesCatalog.snapshot?.revision;
		const previewRevision = activeSelection.preview?.catalogRevision;
		if (revision === undefined) return;

		const revisionChanged =
			observedPreambleCatalogRevision !== null && revision !== observedPreambleCatalogRevision;
		observedPreambleCatalogRevision = revision;
		const previewIsStale = previewRevision !== undefined && previewRevision < revision;
		if (!revisionChanged && !previewIsStale) return;
		if (refreshedPreambleCatalogRevision === revision) return;
		refreshedPreambleCatalogRevision = revision;
		untrack(() => activeSelection.catalogChanged());
	});

	$effect(() => {
		const activeSelection = selection;
		const invalidationVersion = preamblesCatalog.invalidationVersion;
		if (observedPreambleInvalidationVersion === null) {
			observedPreambleInvalidationVersion = invalidationVersion;
			return;
		}
		if (invalidationVersion === observedPreambleInvalidationVersion) return;
		observedPreambleInvalidationVersion = invalidationVersion;
		if (preamblesCatalog.hasLoaded) return;
		untrack(() => activeSelection.catalogChanged());
	});
</script>

<div data-slot="new-chat-preamble-controls">
	<NewChatPreambleSummary
		preview={selection.preview}
		loading={summaryLoading}
		configurable={selection.configurable}
		retryable={validationStatus === 'valid'}
		readyLabel={summaryReadyLabel}
		emptyLabel={summaryEmptyLabel}
		onEdit={() => (pickerOpen = true)}
		{onClear}
		onRetry={() => void selection.refreshPreview()}
	/>

	<NewChatPreamblePicker
		open={pickerOpen}
		choice={selection.choice}
		defaultsIds={(selection.preview?.eligiblePreambles ?? []).map((entry) => entry.id)}
		previewLoading={selection.previewLoading}
		canLoadAutomaticPreview={selection.canLoadAutomaticPreview}
		canonicalProjectPath={selection.canonicalProjectPath || trimmedPath}
		projection={selection.preview}
		description={pickerDescription}
		{onOpenCatalog}
		onClose={() => (pickerOpen = false)}
		onApplyExplicit={(ids) => selection.setExplicit(ids)}
		onApplyDefaults={() => selection.resetToDefaults()}
		onLoadAutomaticPreview={() => selection.loadAutomaticPreview()}
		onRefreshPreview={() => selection.refreshPreview()}
	/>
</div>
