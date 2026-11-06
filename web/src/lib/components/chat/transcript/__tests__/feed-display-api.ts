import type { TranscriptMessage } from '$shared/chat-view';
import type { TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import type { DisplayWindowRequest } from '$shared/transcript-display-contract';
import { displayCutsKey } from '$shared/transcript-display-contract';
import { displayOpen, displayCertificate, displayWindow, displayDetail } from '$lib/chat/transcript/__tests__/display-fixtures.js';
import { displayGroup } from './display-feed-fixtures.js';

// Supplies certified fixtures for ordinary rows and homogeneous Bash runs, not a reference projector.
export function feedDisplayApi() {
	let rows: readonly TranscriptMessage[] = [], open = displayOpen('chat-1', 'generation-1'), hideBash = false, pendingLater = false;
	function window(request: DisplayWindowRequest) {
		const certificate = { ...displayCertificate(open, request.profile), cutsKey: displayCutsKey(request.cuts) };
		const eligible = rows.filter(row => row.message.type !== 'tool-result'
			&& !(row.message.type === 'bash-tool-use' && (hideBash || request.profile.hiddenToolGroups.includes('bash'))));
		const combined = request.profile.combine && eligible.length > 0 && eligible.every(row => row.message.type === 'bash-tool-use');
		const anchor = request.anchor;
		let available = eligible;
		if (anchor.kind === 'before') available = available.filter(row => row.ordinal < anchor.cursor.boundaryOrdinal);
		if (anchor.kind === 'after') available = available.filter(row => row.ordinal > anchor.cursor.boundaryOrdinal);
		if (anchor.kind === 'around') {
			const index = Math.max(0, available.findIndex(row => row.ordinal >= anchor.ordinal));
			available = available.slice(Math.max(0, index - Math.floor(request.limit / 2)));
		}
		const selected = combined ? [] : anchor.kind === 'after' || anchor.kind === 'around'
			? available.slice(0, request.limit) : available.slice(-request.limit);
		const items = combined ? [displayGroup(eligible[0].ordinal, eligible.at(-1)!.ordinal, eligible.length)]
			: selected.map(row => ({ kind: 'row' as const, ordinal: row.ordinal, messageType: row.message.type,
				layout: 'standard' as const, estimatedBodyBytes: 100, permissionOccurrenceId: null }));
		const first = selected[0]?.ordinal ?? 1, last = selected.at(-1)?.ordinal ?? open.sourceHead;
		const earlier = !combined && eligible.some(row => row.ordinal < first);
		const later = !combined && (eligible.some(row => row.ordinal > last) || pendingLater);
		return { ...displayWindow(items, certificate), interval: { after: earlier ? first - 1 : 0, through: later ? last : open.sourceHead },
			earlier: earlier
				? { kind: 'more' as const, cursor: { certificate, boundaryOrdinal: first } } : { kind: 'exhausted-through-watermark' as const },
			later: later ? { kind: 'more' as const, cursor: { certificate, boundaryOrdinal: last } } : { kind: 'exhausted-through-watermark' as const },
			cutPlacements: request.cuts.map(cut => ({ id: cut.id, placement: 'inline' as const })) };
	}
	const api = {
		open: async () => open,
		window: async request => window(request),
		members: async request => {
			const eligible = rows.map(row => row.ordinal).filter(ordinal => ordinal > request.fragment.after && ordinal <= request.fragment.through);
			const anchor = request.anchor;
			let index = anchor.kind === 'first' ? 0 : eligible.findIndex(ordinal => ordinal >= anchor.ordinal);
			if (index < 0) index = eligible.length;
			const start = anchor.kind === 'after' ? index + 1 : anchor.kind === 'before' ? Math.max(0, index - request.limit)
				: anchor.kind === 'around' ? Math.max(0, index - Math.floor(request.limit / 2)) : 0;
			const ordinals = eligible.slice(start, start + request.limit);
			return { certificate: request.certificate, base: request.base, fragment: request.fragment, ordinals,
				earlier: start ? { beforeOrdinal: ordinals[0], remaining: start } : null,
				later: start + ordinals.length < eligible.length ? { afterOrdinal: ordinals.at(-1)!, remaining: eligible.length - start - ordinals.length } : null };
		},
		bodies: async request => {
			const paired = rows[0]?.message.type === 'bash-tool-use' && rows[1]?.message.type === 'tool-result';
			const wanted = new Set([...request.seedOrdinals, ...(paired && request.seedOrdinals.includes(1) ? [2] : [])]);
			return { certificate: request.certificate, details: request.seedOrdinals.map(ordinal => displayDetail(ordinal,
				{ pairedResult: paired && ordinal === 1 ? 2 : null })),
				bodies: rows.filter(row => wanted.has(row.ordinal) && !request.residentOrdinals.includes(row.ordinal)).map(row => ({ ...row, submissionClientMessageId: null })),
				deferredOrdinals: [], nonRenderedOrdinals: [], oversizedOrdinal: null };
		},
		resolve: async request => ({ kind: request.profile.combine ? 'group-member' : 'visible-row', ordinal: request.ordinal, landedOrdinal: request.ordinal }),
		retry: async () => ({ success: true }),
	} satisfies Pick<TranscriptDisplayApi, 'open' | 'window' | 'members' | 'bodies' | 'resolve' | 'retry'>;
	return { api, window, replace(chatId: string, view: string, next: readonly TranscriptMessage[], head: number, later = false) {
		rows = next; open = displayOpen(chatId, view, head); pendingLater = later; return open;
	}, hideBash(value: boolean) { hideBash = value; } };
}
