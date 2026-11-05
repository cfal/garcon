import type { DisplayOpenResponse } from '$shared/transcript-display-open';
import type { PromptRecallSource } from '$lib/chat/composer/prompt-recall.js';
import { transcriptDisplayApi, type TranscriptDisplayApi } from '$lib/api/transcript-display.js';
import { displayCutsKey, displayProfileKey, sameDisplayCertificate } from '$shared/transcript-display-contract';

export function displayPromptRecall(open: DisplayOpenResponse, sourceHead: number, getBashRevision: () => string,
	api: Pick<TranscriptDisplayApi, 'userRows' | 'window' | 'bodies'> = transcriptDisplayApi): PromptRecallSource {
	const target = { chatId: open.chat.id, transcriptViewId: open.transcriptViewId };
	let watermark = sourceHead;
	return {
		async list(signal) {
			const page = await api.userRows({ ...target, mode: 'recall', limit: 100, atWatermark: watermark }, signal);
			if (page.serverInstanceId !== open.serverInstanceId || page.chatId !== target.chatId || page.transcriptViewId !== target.transcriptViewId) throw new Error('Transcript changed');
			if (page.kind !== 'available') throw new Error(page.errorCode ?? 'Prompt history is preparing');
			watermark = page.watermark;
			return page.rows;
		},
		async load(ordinal, signal) {
			const profile = { combine: false, showThinking: false, hiddenToolGroups: ['bash'] as const, bashRevision: getBashRevision() };
			const window = await api.window({ ...target, policyRevision: open.display.policyRevision, profile, cuts: [],
				anchor: { kind: 'around', ordinal }, limit: 1, atWatermark: watermark }, signal);
			if (window.kind !== 'available') throw new Error(window.errorCode ?? 'Prompt history is preparing');
			if (window.certificate.serverInstanceId !== open.serverInstanceId || window.certificate.transcriptViewId !== target.transcriptViewId
				|| window.certificate.chatId !== target.chatId || window.certificate.watermark !== watermark
				|| window.certificate.profileKey !== displayProfileKey(profile) || window.certificate.cutsKey !== displayCutsKey([])) throw new Error('Transcript changed');
			const result = await api.bodies({ certificate: window.certificate, profile, cuts: [], seedOrdinals: [ordinal],
				residentOrdinals: [], limitBodies: 1, estimatedByteBudget: 2 * 1024 * 1024 }, signal);
			if (!sameDisplayCertificate(result.certificate, window.certificate)) throw new Error('Transcript changed');
			const body = result.bodies.find(body => body.ordinal === ordinal);
			if (!body || body.message.type !== 'user-message') throw new Error('Prompt unavailable');
			return body.message.content;
		},
	};
}
