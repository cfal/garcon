import type { TerminalMetadata } from '$shared/terminal';

type TerminalDisplayMetadata = Pick<TerminalMetadata, 'displaySequence' | 'title'>;

export function defaultTerminalDisplayName(
	metadata: Pick<TerminalMetadata, 'displaySequence'>,
	hostLabel = 'Local',
): string {
	return `${hostLabel} ${metadata.displaySequence}`;
}

export function terminalDisplayName(
	metadata: TerminalDisplayMetadata,
	hostLabel = 'Local',
): string {
	return metadata.title ?? defaultTerminalDisplayName(metadata, hostLabel);
}

export function terminalContextName(metadata: TerminalDisplayMetadata, hostLabel: string): string {
	return metadata.title
		? `${hostLabel}: ${metadata.title}`
		: defaultTerminalDisplayName(metadata, hostLabel);
}
