import { describe, expect, it } from 'vitest';
import { WorkMapController } from '../work-map-controller.svelte';

describe('WorkMapController', () => {
	it('updates query and replaces collapse sets immutably', () => {
		const controller = new WorkMapController();
		const initial = controller.collapsedNodeKeys;

		controller.setQuery('lineage');
		controller.toggleNode('chat:parent');

		expect(controller.query).toBe('lineage');
		expect(controller.collapsedNodeKeys).toEqual(new Set(['chat:parent']));
		expect(controller.collapsedNodeKeys).not.toBe(initial);

		const collapsed = controller.collapsedNodeKeys;
		controller.toggleNode('chat:parent');
		expect(controller.collapsedNodeKeys).toEqual(new Set());
		expect(controller.collapsedNodeKeys).not.toBe(collapsed);
	});

	it('collapses and expands the supplied full topology', () => {
		const controller = new WorkMapController();

		controller.collapseAll(['chat:root', 'missing:parent', 'chat:root']);
		expect(controller.collapsedNodeKeys).toEqual(new Set(['chat:root', 'missing:parent']));

		controller.expandAll();
		expect(controller.collapsedNodeKeys).toEqual(new Set());
	});

	it('prunes stale keys without replacing an unchanged set', () => {
		const controller = new WorkMapController();
		controller.collapseAll(['chat:keep', 'chat:remove']);
		const before = controller.collapsedNodeKeys;

		controller.reconcileNodeKeys(new Set(['chat:keep', 'chat:remove', 'chat:other']));
		expect(controller.collapsedNodeKeys).toBe(before);

		controller.reconcileNodeKeys(new Set(['chat:keep']));
		expect(controller.collapsedNodeKeys).toEqual(new Set(['chat:keep']));
		expect(controller.collapsedNodeKeys).not.toBe(before);
	});

	it('ignores project and presentation changes and resets on disposal', () => {
		const controller = new WorkMapController();
		controller.setQuery('query');
		controller.toggleNode('chat:root');

		expect(() => controller.setProjectState({ kind: 'absent' })).not.toThrow();
		expect(() => controller.setPresentationVisible(true)).not.toThrow();
		controller.dispose();

		expect(controller.query).toBe('');
		expect(controller.collapsedNodeKeys).toEqual(new Set());
	});
});
