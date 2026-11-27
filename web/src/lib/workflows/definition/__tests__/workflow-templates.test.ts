import { describe, expect, it } from 'vitest';
import { parseWorkflowDefinition } from '$shared/workflow-definition';
import { WORKFLOW_STARTER_TEMPLATES } from '../workflow-templates';

describe('workflow starter templates', () => {
	it('provides three valid YAML v1 starter definitions with zero parse diagnostics', () => {
		expect(WORKFLOW_STARTER_TEMPLATES).toHaveLength(3);
		expect(new Set(WORKFLOW_STARTER_TEMPLATES.map((template) => template.id)).size).toBe(3);

		for (const template of WORKFLOW_STARTER_TEMPLATES) {
			expect(template.title.trim().length).toBeGreaterThan(0);
			expect(template.summary.trim().length).toBeGreaterThan(0);
			const parsed = parseWorkflowDefinition(template.source);
			expect(parsed.diagnostics).toEqual([]);
			expect(parsed.definition).toBeTruthy();
		}
	});
});
