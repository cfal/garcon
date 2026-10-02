export function codeMirrorLanguageChunk(id: string): string | undefined {
	if (
		id.includes('@codemirror/lang-javascript') ||
		id.includes('@codemirror/lang-json') ||
		id.includes('@lezer/javascript') ||
		id.includes('@lezer/json')
	) {
		return 'vendor-cm-lang-web';
	}

	if (
		id.includes('@codemirror/lang-html') ||
		id.includes('@codemirror/lang-css') ||
		id.includes('@codemirror/lang-xml') ||
		id.includes('@codemirror/lang-sass') ||
		id.includes('@codemirror/lang-less') ||
		id.includes('@codemirror/lang-vue') ||
		id.includes('@lezer/html') ||
		id.includes('@lezer/css') ||
		id.includes('@lezer/sass') ||
		id.includes('@lezer/xml')
	) {
		return 'vendor-cm-lang-markup';
	}

	if (
		id.includes('@codemirror/lang-cpp') ||
		id.includes('@codemirror/lang-go') ||
		id.includes('@codemirror/lang-java') ||
		id.includes('@codemirror/lang-php') ||
		id.includes('@codemirror/lang-python') ||
		id.includes('@codemirror/lang-rust') ||
		id.includes('@codemirror/lang-sql') ||
		id.includes('@codemirror/lang-wast') ||
		id.includes('@codemirror/lang-yaml') ||
		id.includes('@lezer/cpp') ||
		id.includes('@lezer/go') ||
		id.includes('@lezer/java') ||
		id.includes('@lezer/php') ||
		id.includes('@lezer/python') ||
		id.includes('@lezer/rust') ||
		id.includes('@lezer/yaml')
	) {
		return 'vendor-cm-lang-programming';
	}

	if (
		id.includes('@codemirror/lang-angular') ||
		id.includes('@codemirror/lang-jinja') ||
		id.includes('@codemirror/lang-liquid') ||
		id.includes('@codemirror/lang-markdown') ||
		id.includes('@lezer/markdown')
	) {
		return 'vendor-cm-lang-template';
	}

	if (id.includes('@codemirror/language-data')) {
		return 'vendor-cm-lang-metadata';
	}

	if (id.includes('@codemirror/legacy-modes')) {
		return 'vendor-cm-legacy-modes';
	}
}
