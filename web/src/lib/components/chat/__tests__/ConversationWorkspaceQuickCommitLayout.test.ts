import { describe, expect, it } from 'vitest';
import source from '../ConversationWorkspace.svelte?raw';

describe('ConversationWorkspace quick commit layout wiring', () => {
	it('does not couple quick git row visibility or feed padding to each other', () => {
		expect(source).toContain('const quickGitRowVisible = $derived(');
		expect(source).toContain('quickGit.lastNonRepoProject !== projectPath');
		expect(source).toContain('reserveLoadingStatusSpace={selectedIsProcessing}');
		expect(source).not.toContain('reserveLoadingStatusSpace={selectedIsProcessing || quickGit');
		expect(source).not.toContain(
			'!selectedIsProcessing && localSettings.showQuickCommitTray && quickGit.canShowTray',
		);
		expect(source).not.toContain('!selectedIsProcessing && quickGit');
	});
});
