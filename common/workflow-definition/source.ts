import {
  Composer, Lexer, LineCounter, Parser,
  isAlias, isMap, isNode, isScalar, isSeq,
  type CST, type Document, type Node,
} from 'yaml';
import { isRecord, type JsonObject, type JsonValue } from '../json.js';
import { WORKFLOW_DEFINITION_LIMITS, type WorkflowDiagnostic, type WorkflowDiagnosticCode, type WorkflowFieldPath } from './types.js';

const MAX_YAML_DEPTH = 64;
const MAX_YAML_TOKENS = 32_768;
const MAX_DIAGNOSTICS = 64;
const encoder = new TextEncoder();

export class WorkflowSource {
  readonly diagnostics: WorkflowDiagnostic[] = [];
  readonly lines = new LineCounter();
  document?: Document.Parsed;

  constructor(readonly text: string, readonly scope: 'definition' | 'step') {
    this.lines.addNewLine(0);
  }

  get diagnosticsFull(): boolean {
    return this.diagnostics.length >= MAX_DIAGNOSTICS;
  }

  nodeAt(path: WorkflowFieldPath): Node | undefined {
    const node = path.length ? this.document?.getIn(path, true) : this.document?.contents;
    return isNode(node) ? node : undefined;
  }

  issue(code: WorkflowDiagnosticCode, path: WorkflowFieldPath, message: string, node?: Node): void {
    if (this.diagnosticsFull) return;
    node ??= this.nodeAt(path);
    const start = node?.range?.[0] ?? this.nodeAt(path.slice(0, -1))?.range?.[0] ?? 0;
    this.issueAt(code, path, message, start, node?.range?.[1] ?? start + 1);
  }

  issueAt(code: WorkflowDiagnosticCode, path: WorkflowFieldPath, message: string, start: number, end: number): void {
    if (this.diagnosticsFull) return;
    const stepPath = this.scope === 'step' ? ['id']
      : path[0] === 'steps' && typeof path[1] === 'number' ? ['steps', path[1], 'id'] : null;
    const id = stepPath ? this.nodeAt(stepPath) : undefined;
    const stepId = isScalar(id) && typeof id.value === 'string' ? id.value : undefined;
    const position = (offset: number) => {
      offset = Math.max(0, Math.min(offset, this.text.length));
      const { line, col } = this.lines.linePos(offset);
      return { offset, line, column: col };
    };
    this.diagnostics.push({ code, path, message, ...(stepId === undefined ? {} : { stepId }),
      range: { start: position(start), end: position(Math.max(start + 1, end)) } });
  }
}

export function readWorkflowSource(text: string, scope: WorkflowSource['scope']): {
  source: WorkflowSource;
  root: WorkflowField | null;
} {
  const source = new WorkflowSource(text, scope);
  const rejected = { source, root: null };
  const { sourceBytes } = WORKFLOW_DEFINITION_LIMITS;
  if (text.length > sourceBytes || encoder.encode(text).byteLength > sourceBytes) {
    source.issue('source-limit', [], `Keep workflow YAML within ${sourceBytes} UTF-8 bytes.`);
    return rejected;
  }

  const parser = new Parser(source.lines.addNewLine);
  const tokens: CST.Token[] = [];
  let count = 0;
  // The composer walks the CST recursively; bound the parser stack before giving it any documents.
  for (const lexeme of new Lexer().lex(text)) {
    const offset = parser.offset;
    tokens.push(...parser.next(lexeme));
    if (++count > MAX_YAML_TOKENS || parser.stack.length > MAX_YAML_DEPTH) {
      source.issueAt('source-limit', [], 'Simplify the YAML; it has too many tokens or is nested too deeply.', offset, parser.offset);
      return rejected;
    }
  }
  tokens.push(...parser.end());

  let foundDocument = false;
  for (const token of tokens) {
    if (token.type === 'document') {
      if (foundDocument) {
        const start = token.start.find((part) => part.type === 'doc-start');
        source.issueAt('yaml-subset', [], 'Use one YAML document per file. Remove this second document.',
          start?.offset ?? token.offset, (start?.offset ?? token.offset) + 3);
        return rejected;
      }
      foundDocument = true;
    }
    if (token.type === 'directive' && !/^%YAML[ \t]+1\.2(?:[ \t]*(?:#.*)?)?$/u.test(token.source)) {
      source.issueAt('yaml-subset', [], 'Use YAML 1.2 without custom directives. Remove this directive.',
        token.offset, token.offset + token.source.length);
      return rejected;
    }
  }

  const composer = new Composer({ version: '1.2', resolveKnownTags: false, merge: false,
    keepSourceTokens: true, uniqueKeys: false });
  const [document] = composer.compose(tokens, true, text.length);
  source.document = document;
  for (const error of document.errors) {
    source.issueAt('yaml-syntax', [], error.message, ...error.pos);
  }
  if (document.errors.length) return rejected;

  const value = readNode(source, document.contents, []);
  for (const warning of document.warnings) {
    // Explicit tags are diagnosed against the field by readNode.
    if (warning.code !== 'TAG_RESOLVE_FAILED') {
      source.issueAt('yaml-syntax', [], warning.message, ...warning.pos);
    }
  }
  return source.diagnostics.length ? rejected : { source, root: new WorkflowField(source, [], value) };
}

function readNode(source: WorkflowSource, node: Node | null, path: WorkflowFieldPath): JsonValue {
  if (node === null) return null;
  if (isAlias(node) || ('anchor' in node && node.anchor) || node.tag) {
    source.issue('yaml-subset', path, 'Use literal values without YAML tags, anchors, or aliases.', node);
    return null;
  }
  if (isScalar(node)) {
    const value: unknown = node.value;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)
      && (!Number.isInteger(value) || Number.isSafeInteger(value))) return value;
    source.issue('yaml-subset', path, 'Use a finite JSON number and keep integers within the safe range.', node);
    return null;
  }
  if (isSeq(node)) {
    return node.items.map((item, index) => readNode(source, isNode(item) ? item : null, [...path, index]));
  }
  const fields = new Map<string, JsonValue>();
  for (const { key, value } of node.items) {
    if (!isScalar(key) || typeof key.value !== 'string') {
      source.issue('yaml-subset', path, 'Use a string as the mapping key. Quote numeric or boolean names.', isNode(key) ? key : undefined);
      continue;
    }
    const keyPath = [...path, key.value];
    if (key.anchor || key.tag || (key.type === 'PLAIN' && key.value === '<<')) {
      source.issue('yaml-subset', keyPath, 'Use a plain or quoted string key without a tag, anchor, or YAML merge.', key);
    } else if (fields.has(key.value)) {
      source.issue('yaml-subset', keyPath, `Remove the duplicate ${JSON.stringify(key.value)} key.`, key);
    } else {
      fields.set(key.value, readNode(source, isNode(value) ? value : null, keyPath));
    }
  }
  return Object.fromEntries(fields);
}

export class WorkflowField {
  constructor(readonly source: WorkflowSource, readonly path: WorkflowFieldPath, readonly value: JsonValue | undefined) {}

  at(key: string | number): WorkflowField {
    const value = typeof key === 'number' && Array.isArray(this.value) ? this.value[key]
      : typeof key === 'string' && isRecord(this.value) && Object.hasOwn(this.value, key) ? this.value[key]
      : undefined;
    return new WorkflowField(this.source, [...this.path, key], value);
  }

  optional<T>(read: (field: WorkflowField) => T | undefined): T | undefined {
    return this.value === undefined ? undefined : read(this);
  }

  map(allowed?: readonly string[]): JsonObject | undefined {
    if (!isRecord(this.value)) return this.expected('a mapping');
    if (allowed) {
      for (const key of Object.keys(this.value)) {
        if (!allowed.includes(key)) this.at(key).keyIssue('unknown-field', `Remove the unsupported ${JSON.stringify(key)} field here.`);
      }
    }
    return this.value;
  }

  list(min: number, max: number): readonly JsonValue[] | undefined {
    if (!Array.isArray(this.value)) return this.expected('a list');
    if (!this.checkCount(this.value.length, min, max)) return undefined;
    return this.value;
  }

  checkCount(count: number, min: number, max: number): boolean {
    if (count >= min && count <= max) return true;
    this.issue('invalid-value', `Use ${min ? `between ${min} and` : 'at most'} ${max} entries here.`);
    return false;
  }

  text(maxBytes = 4096): string | undefined {
    const value = this.value;
    if (typeof value !== 'string') return this.expected('a string');
    if (value.trim() && value.isWellFormed() && !value.includes('\0') && encoder.encode(value).byteLength <= maxBytes) return value;
    this.issue('invalid-value', `Use nonempty text without NUL bytes, up to ${maxBytes} UTF-8 bytes.`);
    return undefined;
  }

  choice<T extends string>(choices: readonly T[]): T | undefined {
    const label = `one of: ${choices.join(', ')}`;
    if (typeof this.value !== 'string') return this.expected(label);
    const choice = choices.find((entry) => entry === this.value);
    if (choice === undefined) this.issue('invalid-value', `Choose ${label}.`);
    return choice;
  }

  expected(label: string): undefined {
    const field = this.path.length ? JSON.stringify(this.path.at(-1)) : 'this YAML document';
    if (this.value === undefined) this.issue('missing-field', `Add ${field}; it requires ${label}.`);
    else this.issue('invalid-type', `Set ${field} to ${label}.`);
    return undefined;
  }

  issue(code: WorkflowDiagnosticCode, message: string): void {
    this.source.issue(code, this.path, message);
  }

  keyIssue(code: WorkflowDiagnosticCode, message: string): void {
    if (this.source.diagnosticsFull) return;
    const parent = this.source.nodeAt(this.path.slice(0, -1));
    const key = isMap(parent) ? parent.items.find((item) => isScalar(item.key) && item.key.value === this.path.at(-1))?.key : undefined;
    this.source.issue(code, this.path, message, isNode(key) ? key : undefined);
  }
}
