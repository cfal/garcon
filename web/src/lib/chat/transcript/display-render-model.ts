import {
	CommandOutputMessage,
	PermissionCancelledMessage,
	PermissionExpiredMessage,
	PermissionResolvedMessage,
	ToolResultMessage,
	isToolUseMessage,
} from '$shared/chat-types';
import type { RowDescriptor } from '$shared/transcript-display-contract';
import type { ConversationFeedMessageRenderItem, ConversationFeedRenderModel, PermissionTerminalState } from './conversation-feed-items.js';
import type { DisplayWindowSnapshot } from './display-window-controller.js';
import type { DisplayBodyStore } from './display-body-store.js';

export function displayRenderModel(snapshot: DisplayWindowSnapshot, bodies: DisplayBodyStore): ConversationFeedRenderModel {
	const model: ConversationFeedRenderModel = { items: [], toolResultByUseRowId: new Map(), toolResultRowIdByUseRowId: new Map(), permissionTerminalByOccurrence: new Map() };
	const certificate = snapshot.window?.certificate;
	if (!certificate) return model;
	const id = (ordinal: number) => `${certificate.transcriptViewId}:${ordinal}`;
	const descriptors = new Map<number, RowDescriptor>();
	for (const descriptor of snapshot.window!.items) if (descriptor.kind === 'row') descriptors.set(descriptor.ordinal, descriptor);
	const protectedRows = new Map(snapshot.protectedRows.filter(row => !snapshot.details.has(row.detail.ordinal)).map(row => [row.detail.ordinal, row]));
	const details = new Map([...snapshot.details, ...[...protectedRows.values()].map(row => [row.detail.ordinal, row.detail] as const)]);
	for (const [ordinal, detail] of details) {
		const retained = protectedRows.get(ordinal);
		const message = (ordinal: number | null) => ordinal === null ? undefined : bodies.get(retained?.certificate ?? snapshot.detailsCertificate ?? certificate, ordinal)?.message;
		let body = message(ordinal);
		if (!body) continue;
		if (body instanceof CommandOutputMessage && detail.commandFormat && detail.commandFormat !== body.format) {
			body = new CommandOutputMessage(body.timestamp, body.commandId, body.channel, detail.commandFormat, body.content, body.context, body.offset);
		}
		const use = message(detail.pairedUse), result = message(detail.pairedResult);
		const item: ConversationFeedMessageRenderItem = { kind: 'message', id: id(ordinal), ordinal, message: body, index: model.items.length,
			layout: retained?.layout ?? descriptors.get(ordinal)?.layout ?? 'standard',
			...(use && isToolUseMessage(use) ? { pairedToolUse: use } : {}),
			...(detail.questionWrapper !== null ? { permissionWrapperRowId: id(detail.questionWrapper) } : {}) };
		model.items.push(item);
		if (result instanceof ToolResultMessage) {
			model.toolResultByUseRowId.set(item.id, result);
			model.toolResultRowIdByUseRowId.set(item.id, id(detail.pairedResult!));
		}
		const terminal = message(detail.permissionTerminal);
		if (terminal instanceof PermissionResolvedMessage) {
			const value: PermissionTerminalState = { permissionOccurrenceId: terminal.permissionOccurrenceId, state: 'resolved', allowed: terminal.allowed };
			if (terminal.questionResponse?.outcome === 'answered') {
				value.selectedQuestionOptions = Object.fromEntries(terminal.questionResponse.answers.map(answer => [answer.questionId, answer.selectedOptionIds]));
				value.questionTextAnswers = Object.fromEntries(terminal.questionResponse.answers.flatMap(answer => answer.text === undefined ? [] : [[answer.questionId, answer.text]]));
			}
			model.permissionTerminalByOccurrence.set(terminal.permissionOccurrenceId, value);
		} else if (terminal instanceof PermissionCancelledMessage || terminal instanceof PermissionExpiredMessage) {
			model.permissionTerminalByOccurrence.set(terminal.permissionOccurrenceId, { permissionOccurrenceId: terminal.permissionOccurrenceId, state: 'cancelled',
				reason: terminal instanceof PermissionCancelledMessage ? terminal.reason : 'expired' });
		}
	}
	return model;
}
