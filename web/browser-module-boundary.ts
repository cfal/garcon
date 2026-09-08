import { builtinModules } from 'node:module';
import type { Plugin } from 'vite';

const NODE_BUILTINS = new Set(builtinModules);

export function isForbiddenBrowserRuntimeSpecifier(specifier: string): boolean {
	return (
		specifier === 'bun' ||
		specifier.startsWith('bun:') ||
		specifier.startsWith('node:') ||
		NODE_BUILTINS.has(specifier)
	);
}

export function browserModuleBoundaryError(
	source: string,
	importer: string | undefined,
	consumer: 'client' | 'server',
): string | null {
	if (consumer !== 'client' || !importer || !isForbiddenBrowserRuntimeSpecifier(source)) {
		return null;
	}
	return `Browser bundle cannot import runtime built-in ${source} from ${importer}`;
}

export function rejectRuntimeBuiltinsFromBrowserBundle(): Plugin {
	return {
		name: 'reject-runtime-builtins-from-browser-bundle',
		enforce: 'pre',
		resolveId(source, importer) {
			const error = browserModuleBoundaryError(source, importer, this.environment.config.consumer);
			if (error !== null) this.error(error);
			return null;
		},
	};
}
