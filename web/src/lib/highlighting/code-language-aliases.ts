const plaintextAliases = new Set(['plaintext', 'plain', 'text', 'txt']);

const codeFenceLanguageOverrides: Record<string, string> = {
	angular: 'angular template',
	cc: 'cpp',
	csharp: 'c#',
	cs: 'c#',
	cxx: 'cpp',
	golang: 'go',
	h: 'cpp',
	hpp: 'cpp',
	html: 'html',
	js: 'javascript',
	jsonc: 'json',
	kt: 'kotlin',
	kts: 'kotlin',
	md: 'markdown',
	patch: 'diff',
	py: 'python',
	rb: 'ruby',
	rs: 'rust',
	sh: 'shell',
	svg: 'xml',
	ts: 'typescript',
	txt: 'plaintext',
	yml: 'yaml',
};

function firstFenceInfoToken(rawLanguage: string | null | undefined): string {
	const token = rawLanguage?.trim().split(/\s+/)[0] ?? '';
	return token
		.replace(/^language-/i, '')
		.replace(/^\{?\.?/, '')
		.replace(/\}?$/, '');
}

export function normalizeCodeFenceLanguage(rawLanguage: string | null | undefined): string {
	const token = firstFenceInfoToken(rawLanguage);
	if (!token) return '';

	const key = token.toLowerCase();
	if (plaintextAliases.has(key)) return 'plaintext';
	return codeFenceLanguageOverrides[key] ?? key;
}

export function isPlaintextCodeFenceLanguage(rawLanguage: string | null | undefined): boolean {
	const normalized = normalizeCodeFenceLanguage(rawLanguage);
	return !normalized || plaintextAliases.has(normalized);
}

export function shouldAttemptCodeFenceHighlight(rawLanguage: string | null | undefined): boolean {
	return !isPlaintextCodeFenceLanguage(rawLanguage);
}

export function shouldWrapCodeFenceLanguage(rawLanguage: string | null | undefined): boolean {
	const normalized = normalizeCodeFenceLanguage(rawLanguage);
	return !normalized || normalized === 'plaintext' || normalized === 'markdown';
}
