import { describe, expect, it } from 'vitest';
import { AssistantMessage, BashToolUseMessage, CommandOutputMessage, ToolResultMessage, PermissionRequestMessage, PermissionResolvedMessage } from '$shared/chat-types';
import { displayRenderModel } from '../display-render-model.js';
import { DisplayBodyStore } from '../display-body-store.js';
import { emptyDisplayWindow, type DisplayWindowSnapshot } from '../display-window-controller.js';
import { displayCertificate, displayDetail, displayOpen, displayWindow, DISPLAY_TIME } from './display-fixtures.js';

const certificate = displayCertificate(displayOpen('chat-1', 'view-1', 100));
function snapshot(): DisplayWindowSnapshot {
	return { ...emptyDisplayWindow(), window: displayWindow([], certificate), phase: 'available' };
}
function bodyStore(): DisplayBodyStore {
	const bodies = new DisplayBodyStore();
	bodies.resetInstance(certificate.serverInstanceId);
	return bodies;
}

describe('display render model', () => {
	it('uses only certified seeds and never scans resident neighbors for pairing', () => {
		const bodies = bodyStore();
		const tool = new BashToolUseMessage(DISPLAY_TIME, 'reused', 'true');
		const result = new ToolResultMessage(DISPLAY_TIME, 'reused', { content: 'First result' }, false);
		bodies.put(certificate, [{ ordinal: 1, message: tool, submissionClientMessageId: null },
			{ ordinal: 2, message: result, submissionClientMessageId: null },
			{ ordinal: 3, message: new ToolResultMessage(DISPLAY_TIME, 'reused', { content: 'Later result' }, false), submissionClientMessageId: null }]);
		const input = { ...snapshot(), details: new Map([[1, displayDetail(1, { pairedResult: 2 })]]) };
		const model = displayRenderModel(input, bodies);
		expect(model.items.map(row => row.id)).toEqual(['view-1:1']);
		expect(model.toolResultByUseRowId.get('view-1:1')).toBe(result);
		expect(model.toolResultRowIdByUseRowId.get('view-1:1')).toBe('view-1:2');
		expect(displayRenderModel({ ...input, details: new Map([[1, displayDetail(1)]]) }, bodies).toolResultByUseRowId.size).toBe(0);
	});

	it('applies W-qualified command evidence without mutating immutable bodies', () => {
		const bodies = bodyStore();
		const output = new CommandOutputMessage(DISPLAY_TIME, 'command-1', 'stdout', 'markdown', '# Output', null);
		bodies.put(certificate, [{ ordinal: 2, message: output, submissionClientMessageId: null }]);
		const input = { ...snapshot(), details: new Map([[2, displayDetail(2, { commandFormat: 'plain' })]]) };
		expect(displayRenderModel(input, bodies).items[0]).toMatchObject({ id: 'view-1:2', message: { format: 'plain' } });
		expect(output.format).toBe('markdown');
		input.details.set(2, displayDetail(2, { commandFormat: 'markdown' }));
		expect(displayRenderModel(input, bodies).items[0]).toMatchObject({ message: { format: 'markdown' } });
	});

	it('keeps distinct equal-content occurrences and never renders merely cached bodies', () => {
		const bodies = bodyStore();
		for (const ordinal of [1, 2, 3]) bodies.put(certificate, [{ ordinal, message: new AssistantMessage(DISPLAY_TIME, 'Equal'), submissionClientMessageId: null }]);
		const input = { ...snapshot(), details: new Map([[1, displayDetail(1)], [2, displayDetail(2)]]) };
		expect(displayRenderModel(input, bodies).items.map(row => row.id)).toEqual(['view-1:1', 'view-1:2']);
	});

	it('renders a historical permission terminal from its explicit dependency, without granting a capability', () => {
		const bodies = bodyStore();
		const tool = new BashToolUseMessage(DISPLAY_TIME, 'tool-1', 'true');
		bodies.put(certificate, [
			{ ordinal: 4, message: new PermissionRequestMessage(DISPLAY_TIME, 'occurrence-1', tool), submissionClientMessageId: null },
			{ ordinal: 7, message: new PermissionResolvedMessage(DISPLAY_TIME, 'occurrence-1', true), submissionClientMessageId: null },
		]);
		const input = { ...snapshot(), details: new Map([[4, displayDetail(4, { permissionTerminal: 7 })]]) };
		const model = displayRenderModel(input, bodies);
		expect(model.items).toHaveLength(1);
		expect(model.permissionTerminalByOccurrence.get('occurrence-1')).toEqual({ permissionOccurrenceId: 'occurrence-1', state: 'resolved', allowed: true });
		expect(model.items[0]).not.toHaveProperty('control');
	});

	it('keeps protected old detail evidence outside the new completeness claim', () => {
		const bodies = bodyStore();
		const tool = new BashToolUseMessage(DISPLAY_TIME, 'tool', 'true');
		bodies.put(certificate, [{ ordinal: 4, message: tool, submissionClientMessageId: null }]);
		const input = { ...snapshot(), protectedRows: [{ certificate: { ...certificate, watermark: 10 }, detail: displayDetail(4), layout: 'standard' as const }] };
		expect(displayRenderModel(input, bodies).items).toMatchObject([{ id: 'view-1:4', message: tool }]);
		expect(input.window?.items).toEqual([]);
	});

	it('returns no rows without a certified window', () => {
		expect(displayRenderModel(emptyDisplayWindow(), new DisplayBodyStore()).items).toEqual([]);
	});
});
