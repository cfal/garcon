export class ModuleImportError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
		this.name = 'ModuleImportError';
	}
}
