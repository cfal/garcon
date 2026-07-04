<script lang="ts">
	// Dialog for creating a new git branch from the selected base ref.

	import * as m from '$lib/paraglide/messages.js';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import Plus from '@lucide/svelte/icons/plus';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import type { GitRefOption } from '$lib/api/git.js';

		interface NewBranchModalProps {
			currentBranch: string;
			newBranchName: string;
			refOptions?: GitRefOption[];
			selectedBaseRef?: string;
			isLoadingRefs?: boolean;
			isCreatingBranch: boolean;
			onNameChange: (name: string) => void;
			onBaseRefChange?: (ref: string) => void;
			onSearchRefs?: (query: string) => void | Promise<void>;
			onCreateBranch: () => void;
			onClose: () => void;
		}

	let {
		currentBranch,
			newBranchName,
			refOptions = [],
			selectedBaseRef = '',
			isLoadingRefs = false,
			isCreatingBranch,
			onNameChange,
			onBaseRefChange,
			onSearchRefs,
			onCreateBranch,
			onClose,
		}: NewBranchModalProps = $props();

		let baseRefSearchQuery = $state('');
		let baseRefSearchTimeout: ReturnType<typeof setTimeout> | null = null;

		const normalizedBaseRefSearchQuery = $derived(baseRefSearchQuery.trim().toLowerCase());
		const filteredBaseRefs = $derived.by(() => {
			if (!normalizedBaseRefSearchQuery) return refOptions;
			return refOptions.filter((ref) => {
				const name = ref.name.toLowerCase();
				const fullRef = ref.ref.toLowerCase();
				return name.includes(normalizedBaseRefSearchQuery) || fullRef.includes(normalizedBaseRefSearchQuery);
			});
		});
		const selectedBaseRefOption = $derived(refOptions.find((ref) => ref.ref === selectedBaseRef));
		const selectedBaseRefIsVisible = $derived(filteredBaseRefs.some((ref) => ref.ref === selectedBaseRef));

		function handleKeydown(event: KeyboardEvent) {
			if (event.key === 'Enter' && !isCreatingBranch && newBranchName.trim()) {
				onCreateBranch();
			}
		}

		function handleBaseRefSearch(query: string) {
			baseRefSearchQuery = query;
			if (!onSearchRefs) return;
			if (baseRefSearchTimeout) clearTimeout(baseRefSearchTimeout);
			baseRefSearchTimeout = setTimeout(() => {
				baseRefSearchTimeout = null;
				void onSearchRefs(query.trim());
			}, 150);
		}

		function refKindLabel(kind: GitRefOption['kind']) {
			switch (kind) {
				case 'local-branch':
					return m.git_ref_kind_local_branch();
				case 'remote-branch':
					return m.git_ref_kind_remote_branch();
				case 'tag':
					return m.git_ref_kind_tag();
				case 'other':
					return m.git_ref_kind_other();
			}
		}

		$effect(() => {
			return () => {
				if (baseRefSearchTimeout) clearTimeout(baseRefSearchTimeout);
			};
		});
	</script>

<Dialog.Root
	open={true}
	onOpenChange={(open) => {
		if (!open) onClose();
	}}
>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>{m.git_new_branch_title()}</Dialog.Title>
			<Dialog.Description>
				{m.git_new_branch_description({ branch: currentBranch })}
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-4">
			<div>
				<label for="branch-name" class="block text-sm font-medium mb-2"
					>{m.git_new_branch_branch_name()}</label
				>
				<input
					id="branch-name"
					type="text"
					value={newBranchName}
					oninput={(e) => onNameChange((e.target as HTMLInputElement).value)}
					onkeydown={handleKeydown}
					placeholder={m.git_new_branch_placeholder()}
					class="w-full px-3 py-2 border border-border rounded-md bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				/>
			</div>
				<div>
					<label for="branch-base-ref" class="block text-sm font-medium mb-2">
						{m.git_new_branch_base()}
					</label>
					<div class="relative mb-2">
						<input
							type="search"
							value={baseRefSearchQuery}
							oninput={(event) => handleBaseRefSearch(event.currentTarget.value)}
							placeholder={m.git_branch_selector_find_ref()}
							aria-label={m.git_branch_selector_find_ref_label()}
							disabled={isCreatingBranch}
							class="w-full rounded-md border border-border bg-background px-3 py-2 pr-9 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
						/>
						{#if isLoadingRefs}
							<LoaderCircle
								class="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
								aria-hidden="true"
							/>
						{/if}
					</div>
					<select
						id="branch-base-ref"
						value={selectedBaseRef}
						onchange={(event) => onBaseRefChange?.(event.currentTarget.value)}
						disabled={isCreatingBranch}
						class="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
					>
						<option value="">{m.git_new_branch_current_head({ branch: currentBranch })}</option>
						{#if selectedBaseRef && !selectedBaseRefIsVisible}
							<option value={selectedBaseRef}>{selectedBaseRefOption?.name ?? selectedBaseRef}</option>
						{/if}
						{#each filteredBaseRefs as ref (ref.ref)}
							<option value={ref.ref}>{ref.name} ({refKindLabel(ref.kind)})</option>
						{/each}
					</select>
				</div>
		</div>

		<Dialog.Footer>
			<button
				onclick={() => {
					onClose();
					onNameChange('');
				}}
				class="px-4 py-2 text-sm text-muted-foreground hover:bg-accent rounded-md"
				>{m.git_new_branch_cancel()}</button
			>
			<button
				onclick={onCreateBranch}
				disabled={!newBranchName.trim() || isCreatingBranch}
				class="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
			>
				{#if isCreatingBranch}
					<LoaderCircle class="w-3 h-3 animate-spin" />
					<span>{m.git_new_branch_creating()}</span>
				{:else}
					<Plus class="w-3 h-3" />
					<span>{m.git_new_branch_create()}</span>
				{/if}
			</button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
