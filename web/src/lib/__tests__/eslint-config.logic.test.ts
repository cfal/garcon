import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const eslint = new ESLint({ cwd: fileURLToPath(new URL('../../../', import.meta.url)) });
beforeAll(async () => { await eslint.calculateConfigForFile('src/lib/components/example.ts'); }, 60_000);

describe('effective ESLint boundaries', () => {
	it.each([
		'src/lib/components/example.ts',
		'src/lib/chat/example.ts',
		'src/lib/utils/example.ts',
		'src/lib/chat/__tests__/example.test.ts',
	])('keeps the icon restriction in %s', async (filePath) => {
		const config = await eslint.calculateConfigForFile(filePath);
		expect(config.rules['no-restricted-imports'][1].paths).toContainEqual(expect.objectContaining({ name: '@lucide/svelte' }));
		const [result] = await eslint.lintText("import { Search } from '@lucide/svelte'; export { Search };", { filePath });
		expect(result.messages.some(message => message.ruleId === 'no-restricted-imports')).toBe(true);
	});

	it.each(['src/lib/chat/example.ts', 'src/lib/utils/example.ts'])('retains the component boundary in %s', async (filePath) => {
		const [result] = await eslint.lintText("import type { Example } from '$lib/components/example'; export type { Example };", { filePath });
		expect(result.messages.some(message => message.ruleId === 'no-restricted-imports')).toBe(true);
	});

	it('keeps utilities independent and API handling owned by the API layer', async () => {
		for (const [filePath, source, rule] of [
			['src/lib/utils/example.ts', "import { value } from '$lib/chat/example'; export { value };", 'no-restricted-imports'],
			['src/lib/chat/example.ts', "import { apiFetch as rawFetch } from '$lib/api/client'; export { rawFetch };", 'no-restricted-syntax'],
		]) {
			const [result] = await eslint.lintText(source, { filePath });
			expect(result.messages.some(message => message.ruleId === rule)).toBe(true);
		}
		const [allowed] = await eslint.lintText("import { apiFetch } from './client'; export { apiFetch };", { filePath: 'src/lib/api/example.ts' });
		expect(allowed.messages).toEqual([]);
	});
});
