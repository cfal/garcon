<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getWorkspaceCoordinator } from '$lib/context';
	import * as m from '$lib/paraglide/messages.js';

	const workspace = getWorkspaceCoordinator();
</script>

<Dialog.Root
	open={Boolean(workspace.closeGuardRequest)}
	onOpenChange={(open) => {
		if (!open) workspace.resolveCloseGuard(false);
	}}
>
	<Dialog.Content class="sm:max-w-md" showCloseButton={false}>
		<Dialog.Header>
			<Dialog.Title>{workspace.closeGuardRequest?.title}</Dialog.Title>
			<Dialog.Description>{workspace.closeGuardRequest?.description}</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => workspace.resolveCloseGuard(false)}
				>{m.common_cancel()}</Button
			>
			<Button variant="destructive" onclick={() => workspace.resolveCloseGuard(true)}>
				{workspace.closeGuardRequest?.confirmLabel}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
