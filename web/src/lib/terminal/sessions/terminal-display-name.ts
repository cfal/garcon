import * as m from '$lib/paraglide/messages.js';
import type { TerminalMetadata } from '$shared/terminal';

type TerminalDisplayMetadata = Pick<TerminalMetadata, 'displaySequence' | 'title'>;

export function defaultTerminalDisplayName(
	metadata: Pick<TerminalMetadata, 'displaySequence'>,
): string {
	return m.workspace_surface_terminal_number({ number: metadata.displaySequence });
}

export function terminalDisplayName(metadata: TerminalDisplayMetadata): string {
	return metadata.title ?? defaultTerminalDisplayName(metadata);
}
