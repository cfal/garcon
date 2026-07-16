import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'svelte/compiler';
import { describe, expect, it } from 'vitest';

const componentsRoot = join(process.cwd(), 'src/lib/components');
const nonZoomingInputTypes = /type=["'](?:button|checkbox|color|file|hidden|radio|range|reset|submit)["']/;
const safeFontSize = /(?:^|[\s'"`])(?:text-base|text-\[16px\])(?=$|[\s'"`])/;
const unsafeFontOverride =
	/(?:^|[\s'"`])(?:text-(?:xs|sm)|(?:sm|md|lg|xl|2xl):text-(?:xs|sm)|text-\[(?:[0-9]|1[0-5])px\])(?=$|[\s'"`])/;

interface ElementNode {
	type: 'Component' | 'RegularElement';
	name: string;
	start: number;
	attributes: Array<Record<string, unknown>>;
}

function collectSvelteFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		if (entry.name === '__tests__') return [];
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return collectSvelteFiles(path);
		return entry.isFile() && entry.name.endsWith('.svelte') ? [path] : [];
	});
}

function isDialogSource(source: string): boolean {
	return (
		/<\w*Dialog\.Content\b/.test(source) ||
		/<dialog\b/.test(source) ||
		/role\s*=\s*(["'])(?:dialog|alertdialog)\1/.test(source)
	);
}

function isElementNode(value: Record<string, unknown>): value is Record<string, unknown> & ElementNode {
	return (
		(value.type === 'Component' || value.type === 'RegularElement') &&
		typeof value.name === 'string' &&
		typeof value.start === 'number' &&
		Array.isArray(value.attributes)
	);
}

function visitElements(value: unknown, visit: (node: ElementNode) => void): void {
	if (Array.isArray(value)) {
		for (const child of value) visitElements(child, visit);
		return;
	}
	if (!value || typeof value !== 'object') return;

	const record = value as Record<string, unknown>;
	if (isElementNode(record)) visit(record);
	for (const child of Object.values(record)) visitElements(child, visit);
}

function attributeSource(node: ElementNode, name: string, source: string): string | null {
	const attribute = node.attributes.find(
		(candidate) => candidate.type === 'Attribute' && candidate.name === name,
	);
	if (!attribute || typeof attribute.start !== 'number' || typeof attribute.end !== 'number') {
		return null;
	}
	return source.slice(attribute.start, attribute.end);
}

function sourceLocation(path: string, source: string, offset: number): string {
	const line = source.slice(0, offset).split('\n').length;
	return `${relative(process.cwd(), path)}:${line}`;
}

function auditDialogControls(path: string, source: string): string[] {
	const failures: string[] = [];
	const ast = parse(source, { modern: true });

	visitElements(ast.fragment, (node) => {
		const isNativeControl =
			node.type === 'RegularElement' && ['input', 'select', 'textarea'].includes(node.name);
		const isSharedControl = node.type === 'Component' && ['Input', 'Textarea'].includes(node.name);
		if (!isNativeControl && !isSharedControl) return;

		const type = attributeSource(node, 'type', source);
		if (node.name === 'input' && type && nonZoomingInputTypes.test(type)) return;

		const location = sourceLocation(path, source, node.start);
		const className = attributeSource(node, 'class', source);
		if (className && unsafeFontOverride.test(className)) {
			failures.push(`${location} overrides the control below 16px without pointer-fine`);
		}
		if (isNativeControl && (!className || !safeFontSize.test(className))) {
			failures.push(`${location} does not declare a 16px touch font size`);
		}
	});

	return failures;
}

describe('dialog input zoom protection', () => {
	it('requires dialog controls to own their iOS-safe font size', () => {
		const failures = collectSvelteFiles(componentsRoot)
			.map((path) => [path, readFileSync(path, 'utf8')] as const)
			.filter(([, source]) => isDialogSource(source))
			.flatMap(([path, source]) => auditDialogControls(path, source));

		expect(failures).toEqual([]);
	});

	it('keeps the shared form controls safe without global CSS', () => {
		const sharedControls = [
			join(componentsRoot, 'ui/input/input.svelte'),
			join(componentsRoot, 'ui/textarea/textarea.svelte'),
		];
		const failures = sharedControls.flatMap((path) =>
			auditDialogControls(path, readFileSync(path, 'utf8')),
		);

		expect(failures).toEqual([]);
	});
});
