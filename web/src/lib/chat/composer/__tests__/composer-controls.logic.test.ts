import { describe, expect, it } from 'vitest';
import { buildComposerSendPresentation, buildThinkingOptions } from '$lib/chat/composer/composer-controls.js';
import type { AgentSettingsEnvelope } from '$shared/agent-integration';
import * as m from '$lib/paraglide/messages.js';

describe('buildComposerSendPresentation', () => {
	const defaults: AgentSettingsEnvelope = { ownerId: 'test-agent', schemaVersion: 2, values: {} };
	const catalog = {
		isValidated: true,
		error: null,
		getDefaultAgentSettings: () => defaults,
		getAgentSettingsDescriptors: () => [],
	} satisfies Parameters<typeof buildComposerSendPresentation>[0];
	const selection = { agentId: 'test-agent', agentSettings: null };
	const availability = { executorReady: true, controllerCommand: false, requiresQueuedSubmission: false };

	it('uses catalog defaults only for absent settings', () => {
		const presentation = buildComposerSendPresentation(catalog, selection, availability);
		expect(presentation.settingsEnvelope).toBe(defaults);
		expect(presentation.settingsCompatible).toBe(true);
		expect(presentation.sendTitle).toBe(m.chat_composer_send_message());
		expect(selection.agentSettings).toBeNull();
	});

	it('preserves incompatible saved settings instead of substituting defaults', () => {
		const saved = { ...defaults, schemaVersion: 1 };
		const presentation = buildComposerSendPresentation(catalog, { ...selection, agentSettings: saved }, availability);
		expect(presentation.settingsEnvelope).toBe(saved);
		expect(presentation.settingsCompatible).toBe(false);
		expect(presentation.sendTitle).toBe('Saved provider settings are unavailable or incompatible.');
	});

	it('does not invent settings while catalog defaults are unavailable', () => {
		const presentation = buildComposerSendPresentation(
			{ ...catalog, getDefaultAgentSettings: () => null }, selection, availability,
		);
		expect(presentation.settingsEnvelope).toBeNull();
		expect(presentation.settingsCompatible).toBe(false);
	});

	it('prioritizes loading over compatibility and queue labels', () => {
		const presentation = buildComposerSendPresentation(
			{ ...catalog, isValidated: false }, { ...selection, agentSettings: { ...defaults, schemaVersion: 1 } },
			{ ...availability, requiresQueuedSubmission: true },
		);
		expect(presentation.sendTitle).toBe(m.chat_composer_loading_models());
	});

	it('labels queued execution without blocking controller-only commands', () => {
		expect(buildComposerSendPresentation(catalog, selection, { ...availability, requiresQueuedSubmission: true }).sendTitle)
			.toBe(m.chat_composer_queue_message());
		const presentation = buildComposerSendPresentation(
			{ ...catalog, isValidated: false, getDefaultAgentSettings: () => null }, selection,
			{ ...availability, controllerCommand: true, requiresQueuedSubmission: true },
		);
		expect(presentation.settingsCompatible).toBe(false);
		expect(presentation.sendTitle).toBe(m.chat_composer_send_message());
	});
});

describe('buildThinkingOptions', () => {
	const allModes = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

	it('includes every mode declared by the integration catalog', () => {
		expect(buildThinkingOptions(allModes).map((option) => option.label)).toEqual([
			'Default',
			'Low',
			'Medium',
			'High',
			'X-High',
			'Max',
			'Ultra',
		]);
	});

	it('marks Ultra as rainbow for GPT-6 Sol and GPT-5.6 Sol', () => {
		const solUltra = buildThinkingOptions(allModes, 'gpt-6-sol').find(
			(option) => option.value === 'ultra',
		);
		const latestSolUltra = buildThinkingOptions(allModes, 'gpt-6.1-sol').find(
			(option) => option.value === 'ultra',
		);
		const previousSolUltra = buildThinkingOptions(allModes, 'gpt-5.6-sol').find(
			(option) => option.value === 'ultra',
		);
		const terraUltra = buildThinkingOptions(allModes, 'gpt-5.6-terra').find(
			(option) => option.value === 'ultra',
		);

		expect(solUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(latestSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(previousSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
		expect(terraUltra).not.toHaveProperty('rainbow');
	});

	it('keeps higher-effort icons distinct from their tinted fills', () => {
		const options = buildThinkingOptions(['xhigh', 'max', 'ultra']);
		for (const [index, option] of options.entries()) {
			const classes = option.toneClass.split(' ');
			expect(classes).toContain('text-foreground');
			expect(classes).not.toContain('text-destructive');
			expect(classes).toContain(`bg-destructive/${20 + index * 10}`);
			expect(classes).toContain(`hover:bg-destructive/${30 + index * 10}`);
		}
	});

	it('recognizes GPT-6 Sol through an API endpoint model value', () => {
		const endpointSolUltra = buildThinkingOptions(allModes, 'acme-openai:gpt-6-sol').find(
			(option) => option.value === 'ultra',
		);

		expect(endpointSolUltra).toMatchObject({ rainbow: true, toneClass: 'rainbow-ultra-surface' });
	});

	it('keeps undeclared modes out of the options', () => {
		expect(buildThinkingOptions(['none', 'high']).map((option) => option.value)).toEqual([
			'none',
			'high',
		]);
	});

	it('preserves the catalog order', () => {
		expect(buildThinkingOptions(['max', 'none', 'medium']).map((option) => option.value)).toEqual([
			'max',
			'none',
			'medium',
		]);
	});
});
