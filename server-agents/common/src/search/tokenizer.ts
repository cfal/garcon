import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

export const SEARCH_TOKENIZER_SEMANTICS_VERSION = 1;
export const SEARCH_QUERY_COMPILER_SEMANTICS_VERSION = 1;
export const SEARCH_TOKENIZER_MAX_ROWS = 16;
export const SEARCH_TOKENIZER_MAX_BODY_CODE_UNITS = 64_000;
export const SEARCH_TOKENIZER_MAX_NATIVE_TOKENS = 65_536;
export const SEARCH_TOKENIZER_MAX_DOCUMENT_TERMS = 65_536;
export const SEARCH_TOKENIZER_MAX_TERM_BYTES = 1_048_576;
export const SEARCH_TOKENIZER_MAX_POSITION_BYTES = 524_288;
export const SEARCH_QUERY_MAX_NATIVE_TOKENS = 8_192;
export const SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES = 32 * 1_024;
export const SEARCH_TOKENIZER_HASH_SIZE_BYTES = 8 * 1_024 * 1_024;

const TOKENIZER_SPEC = 'unicode61 remove_diacritics 2';
const TOKENIZER_SENTINEL = 'Crème 東京 foo_bar 한글';
const TOKENIZER_FINGERPRINT_DOMAIN = 'garcon/transcript-search/tokenizer-fingerprint/v8\0';
const POSTING_ENCODING = 'positive-delta-uleb128-v1';
const MAX_POSITION_VARINT_BYTES = 3;
const APPROVED_FTS5_SOURCE_IDS = new Set([
  'fts5: 2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b',
  'fts5: 2026-06-03 19:12:13 d6e03d8c777cfa2d35e3b60d8ec3e0187f3e9f99d8e2ee9cac695fd6fcdf1a24',
]);

export interface NativeQueryToken {
  readonly term: Uint8Array;
  readonly position: number;
}

export interface CanonicalPosting {
  readonly term: Uint8Array;
  readonly frequency: number;
  readonly positions: Uint8Array;
}

export interface TokenizedDocument {
  readonly document: number;
  readonly tokenCount: number;
  readonly termCount: number;
  readonly termBytes: number;
  readonly positionBytes: number;
  readonly postings: readonly CanonicalPosting[];
}

export interface TokenizedDocumentBatch {
  readonly documents: readonly TokenizedDocument[];
  readonly acceptedDocumentCount: number;
  readonly nativeTokenCount: number;
  readonly distinctTermCount: number;
  readonly termBytes: number;
  readonly positionBytes: number;
}

interface VocabInstance {
  readonly term: Uint8Array;
  readonly doc: number;
  readonly col: string;
  readonly offset: number;
}

interface MutablePosting {
  readonly term: Uint8Array;
  readonly positions: number[];
}

interface InstanceLimits {
  readonly maxNativeTokens: number;
  readonly maxDocumentTerms: number;
  readonly maxTermBytes: number;
  readonly termBytes: 'occurrences' | 'document-terms';
  readonly errorCode: 'SEARCH_QUERY_INVALID' | 'SEARCH_TOKENIZER_LIMIT';
}

function tokenizerError(code: string): Error {
  return new Error(code);
}

function uint32(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw tokenizerError('SEARCH_TOKENIZER_INVALID');
  }
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function field(bytes: Uint8Array): Buffer {
  return Buffer.concat([uint32(bytes.byteLength), Buffer.from(bytes)]);
}

function hasWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireDocumentBody(body: string): void {
  if (typeof body !== 'string' || body.length === 0
      || body.length > SEARCH_TOKENIZER_MAX_BODY_CODE_UNITS
      || !hasWellFormedUtf16(body)) {
    throw tokenizerError('SEARCH_TOKENIZER_INVALID');
  }
}

export function compareSearchTerms(left: Uint8Array, right: Uint8Array): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function encodeCanonicalPositions(positions: readonly number[]): Uint8Array {
  const bytes: number[] = [];
  let previous = -1;
  for (const position of positions) {
    if (!Number.isSafeInteger(position) || position <= previous) {
      throw tokenizerError('SEARCH_POSTING_INVALID');
    }
    let delta = position - previous;
    while (delta >= 0x80) {
      bytes.push((delta & 0x7f) | 0x80);
      delta = Math.floor(delta / 0x80);
    }
    bytes.push(delta);
    previous = position;
  }
  return Uint8Array.from(bytes);
}

export function decodeCanonicalPositions(input: {
  readonly encoded: Uint8Array;
  readonly frequency: number;
  readonly maxPositionExclusive: number;
}): readonly number[] {
  if (!Number.isSafeInteger(input.frequency) || input.frequency <= 0
      || !Number.isSafeInteger(input.maxPositionExclusive)
      || input.maxPositionExclusive <= 0) {
    throw tokenizerError('SEARCH_POSTING_INVALID');
  }
  const positions: number[] = [];
  let byteIndex = 0;
  let previous = -1;
  while (byteIndex < input.encoded.byteLength && positions.length < input.frequency) {
    let delta = 0;
    let multiplier = 1;
    let groups = 0;
    while (true) {
      if (byteIndex >= input.encoded.byteLength || groups >= 8) {
        throw tokenizerError('SEARCH_POSTING_INVALID');
      }
      const byte = input.encoded[byteIndex]!;
      byteIndex += 1;
      const payload = byte & 0x7f;
      if (payload > Math.floor((Number.MAX_SAFE_INTEGER - delta) / multiplier)) {
        throw tokenizerError('SEARCH_POSTING_INVALID');
      }
      delta += payload * multiplier;
      groups += 1;
      if ((byte & 0x80) === 0) {
        if (groups > 1 && payload === 0) throw tokenizerError('SEARCH_POSTING_INVALID');
        break;
      }
      if (multiplier > Math.floor(Number.MAX_SAFE_INTEGER / 0x80)) {
        throw tokenizerError('SEARCH_POSTING_INVALID');
      }
      multiplier *= 0x80;
    }
    if (delta <= 0) throw tokenizerError('SEARCH_POSTING_INVALID');
    const position = previous + delta;
    if (!Number.isSafeInteger(position)
        || position <= previous
        || position >= input.maxPositionExclusive) {
      throw tokenizerError('SEARCH_POSTING_INVALID');
    }
    positions.push(position);
    previous = position;
  }
  if (positions.length !== input.frequency || byteIndex !== input.encoded.byteLength) {
    throw tokenizerError('SEARCH_POSTING_INVALID');
  }
  return positions;
}

function assertNoDiskPath(db: Database): void {
  const databases = db.query<{ name: string; file: string }, []>('PRAGMA database_list').all();
  if (databases.some((entry) => entry.file !== '' || !['main', 'temp'].includes(entry.name))) {
    throw tokenizerError('SEARCH_TOKENIZER_DISK_PATH');
  }
}

function createTokenizerDatabase(): Database {
  const db = new Database(':memory:');
  try {
    const journalMode = String(
      db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = MEMORY').get()?.journal_mode,
    ).toLowerCase();
    db.exec('PRAGMA temp_store = MEMORY');
    db.exec('PRAGMA cache_spill = OFF');
    const tempStore = Number(db.query<{ temp_store: number }, []>('PRAGMA temp_store').get()?.temp_store);
    const cacheSpill = Number(
      db.query<{ cache_spill: number }, []>('PRAGMA cache_spill').get()?.cache_spill,
    );
    if (journalMode !== 'memory' || tempStore !== 2 || cacheSpill !== 0) {
      throw tokenizerError('SEARCH_TOKENIZER_CONFIGURATION');
    }
    assertNoDiskPath(db);
    db.exec(`
      CREATE VIRTUAL TABLE tokenizer_fts USING fts5(
        body,
        content='',
        columnsize=0,
        tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE tokenizer_vocab USING fts5vocab(tokenizer_fts, instance);
    `);
    const configure = db.query(
      'INSERT INTO tokenizer_fts(tokenizer_fts, rank) VALUES (?, ?)',
    );
    configure.run('automerge', 0);
    configure.run('crisismerge', 1999);
    configure.run('hashsize', SEARCH_TOKENIZER_HASH_SIZE_BYTES);
    const plan = db.query<{ detail: string }, []>(`
      EXPLAIN QUERY PLAN
      SELECT CAST(term AS BLOB), doc, col, offset FROM tokenizer_vocab
    `).all();
    if (plan.some((entry) => /TEMP B-TREE/i.test(entry.detail))) {
      throw tokenizerError('SEARCH_TOKENIZER_CONFIGURATION');
    }
    return db;
  } catch (error) {
    db.close(false);
    throw error;
  }
}

function computeFingerprint(sourceId: string, sentinel: readonly VocabInstance[]): Uint8Array {
  const sorted = [...sentinel].sort((left, right) => (
    compareSearchTerms(left.term, right.term)
    || left.offset - right.offset
    || left.doc - right.doc
    || left.col.localeCompare(right.col)
  ));
  const parts: Uint8Array[] = [Buffer.from(TOKENIZER_FINGERPRINT_DOMAIN, 'ascii')];
  parts.push(field(uint32(SEARCH_TOKENIZER_SEMANTICS_VERSION)));
  parts.push(field(Buffer.from(sourceId, 'utf8')));
  parts.push(field(Buffer.from(TOKENIZER_SPEC, 'utf8')));
  parts.push(field(Buffer.from(TOKENIZER_SENTINEL, 'utf8')));
  parts.push(field(uint32(sorted.length)));
  for (const tuple of sorted) {
    parts.push(field(tuple.term));
    parts.push(field(uint32(tuple.doc)));
    parts.push(field(Buffer.from(tuple.col, 'utf8')));
    parts.push(field(uint32(tuple.offset)));
  }
  parts.push(field(uint32(SEARCH_QUERY_COMPILER_SEMANTICS_VERSION)));
  parts.push(field(Buffer.from(POSTING_ENCODING, 'utf8')));
  return createHash('sha256').update(Buffer.concat(parts.map((part) => Buffer.from(part)))).digest();
}

function documentFromInstances(document: number, instances: readonly VocabInstance[]): TokenizedDocument {
  const byTerm = new Map<string, MutablePosting>();
  let occurrenceCount = 0;
  for (const instance of instances) {
    if (instance.doc !== document || instance.col !== 'body'
        || !Number.isSafeInteger(instance.offset) || instance.offset < 0) {
      throw tokenizerError('SEARCH_TOKENIZER_INVALID');
    }
    const term = Uint8Array.from(instance.term);
    if (term.byteLength === 0 || term.byteLength > 32_768) {
      throw tokenizerError('SEARCH_TOKENIZER_INVALID');
    }
    const key = Buffer.from(term).toString('hex');
    const posting = byTerm.get(key) ?? { term, positions: [] };
    posting.positions.push(instance.offset);
    byTerm.set(key, posting);
    occurrenceCount += 1;
  }
  const postings = [...byTerm.values()]
    .sort((left, right) => compareSearchTerms(left.term, right.term))
    .map<CanonicalPosting>((posting) => {
      posting.positions.sort((left, right) => left - right);
      const positions = encodeCanonicalPositions(posting.positions);
      decodeCanonicalPositions({
        encoded: positions,
        frequency: posting.positions.length,
        maxPositionExclusive: occurrenceCount,
      });
      return {
        term: Uint8Array.from(posting.term),
        frequency: posting.positions.length,
        positions,
      };
    });
  return {
    document,
    tokenCount: occurrenceCount + 1,
    termCount: postings.length,
    termBytes: postings.reduce((total, posting) => total + posting.term.byteLength, 0),
    positionBytes: postings.reduce((total, posting) => total + posting.positions.byteLength, 0),
    postings,
  };
}

function validateDocumentCaps(document: TokenizedDocument): void {
  if (document.tokenCount - 1 > SEARCH_TOKENIZER_MAX_NATIVE_TOKENS
      || document.termCount > SEARCH_TOKENIZER_MAX_DOCUMENT_TERMS
      || document.termBytes > SEARCH_TOKENIZER_MAX_TERM_BYTES
      || document.positionBytes > SEARCH_TOKENIZER_MAX_POSITION_BYTES) {
    throw tokenizerError('SEARCH_TOKENIZER_LIMIT');
  }
}

export class SearchTokenizer {
  #db: Database;
  #closed = false;
  readonly sourceId: string;
  readonly #fingerprint: Uint8Array;

  private constructor() {
    this.#db = createTokenizerDatabase();
    try {
      this.sourceId = String(
        this.#db.query<{ sourceId: string }, []>('SELECT fts5_source_id() AS sourceId').get()
          ?.sourceId ?? '',
      );
      if (!APPROVED_FTS5_SOURCE_IDS.has(this.sourceId)) {
        throw tokenizerError('SEARCH_TOKENIZER_UNSUPPORTED');
      }
      const sentinel = this.#tokenizeInstances([TOKENIZER_SENTINEL], {
        maxNativeTokens: 16,
        maxDocumentTerms: 16,
        maxTermBytes: 256,
        termBytes: 'occurrences',
        errorCode: 'SEARCH_TOKENIZER_LIMIT',
      });
      const expected = [
        ['bar', 3],
        ['creme', 0],
        ['foo', 2],
        ['東京', 1],
        ['한글', 4],
      ] as const;
      const actual = [...sentinel]
        .sort((left, right) => compareSearchTerms(left.term, right.term))
        .map((entry) => [Buffer.from(entry.term).toString('utf8'), entry.offset] as const);
      if (actual.length !== expected.length
          || actual.some((entry, index) => entry[0] !== expected[index]![0]
            || entry[1] !== expected[index]![1])) {
        throw tokenizerError('SEARCH_TOKENIZER_UNSUPPORTED');
      }
      this.#fingerprint = computeFingerprint(this.sourceId, sentinel);
      assertNoDiskPath(this.#db);
    } catch (error) {
      this.#db.close(false);
      this.#closed = true;
      throw error;
    }
  }

  static create(): SearchTokenizer {
    return new SearchTokenizer();
  }

  get fingerprint(): Uint8Array {
    return Uint8Array.from(this.#fingerprint);
  }

  tokenizeQuery(text: string): readonly NativeQueryToken[] {
    if (typeof text !== 'string' || !hasWellFormedUtf16(text)) {
      throw tokenizerError('SEARCH_QUERY_INVALID');
    }
    const instances = this.#withRecovery(() => this.#tokenizeInstances([text], {
      maxNativeTokens: SEARCH_QUERY_MAX_NATIVE_TOKENS,
      maxDocumentTerms: SEARCH_QUERY_MAX_NATIVE_TOKENS,
      maxTermBytes: SEARCH_QUERY_MAX_NORMALIZED_TERM_BYTES,
      termBytes: 'occurrences',
      errorCode: 'SEARCH_QUERY_INVALID',
    }));
    return instances
      .map((entry) => ({ term: Uint8Array.from(entry.term), position: entry.offset }))
      .sort((left, right) => left.position - right.position
        || compareSearchTerms(left.term, right.term));
  }

  tokenizeDocument(body: string): TokenizedDocument {
    requireDocumentBody(body);
    const instances = this.#withRecovery(() => this.#tokenizeInstances([body], {
      maxNativeTokens: SEARCH_TOKENIZER_MAX_NATIVE_TOKENS,
      maxDocumentTerms: SEARCH_TOKENIZER_MAX_DOCUMENT_TERMS,
      maxTermBytes: SEARCH_TOKENIZER_MAX_TERM_BYTES,
      termBytes: 'document-terms',
      errorCode: 'SEARCH_TOKENIZER_LIMIT',
    }));
    const document = documentFromInstances(1, instances);
    validateDocumentCaps(document);
    return document;
  }

  tokenizeDocuments(bodies: readonly string[]): TokenizedDocumentBatch {
    if (!Array.isArray(bodies) || bodies.length > SEARCH_TOKENIZER_MAX_ROWS) {
      throw tokenizerError('SEARCH_TOKENIZER_INVALID');
    }
    if (SEARCH_TOKENIZER_MAX_NATIVE_TOKENS * MAX_POSITION_VARINT_BYTES
        > SEARCH_TOKENIZER_MAX_POSITION_BYTES) {
      throw tokenizerError('SEARCH_TOKENIZER_CONFIGURATION');
    }
    const documents: TokenizedDocument[] = [];
    let nativeTokenCount = 0;
    let distinctTermCount = 0;
    let termBytes = 0;
    let positionBytes = 0;
    // One helper cycle per document preserves input-order prefix selection without a temp sort.
    for (const body of bodies) {
      requireDocumentBody(body);
      let tokenized: TokenizedDocument;
      try {
        const instances = this.#withRecovery(() => this.#tokenizeInstances([body], {
          maxNativeTokens: SEARCH_TOKENIZER_MAX_NATIVE_TOKENS - nativeTokenCount,
          maxDocumentTerms: SEARCH_TOKENIZER_MAX_DOCUMENT_TERMS - distinctTermCount,
          maxTermBytes: SEARCH_TOKENIZER_MAX_TERM_BYTES - termBytes,
          termBytes: 'document-terms',
          errorCode: 'SEARCH_TOKENIZER_LIMIT',
        }));
        tokenized = documentFromInstances(1, instances);
        validateDocumentCaps(tokenized);
      } catch (error) {
        if (error instanceof Error && error.message === 'SEARCH_TOKENIZER_LIMIT') break;
        throw error;
      }
      const nextNativeTokens = nativeTokenCount + tokenized.tokenCount - 1;
      const nextDistinctTerms = distinctTermCount + tokenized.termCount;
      const nextTermBytes = termBytes + tokenized.termBytes;
      const nextPositionBytes = positionBytes + tokenized.positionBytes;
      if (nextNativeTokens > SEARCH_TOKENIZER_MAX_NATIVE_TOKENS
          || nextDistinctTerms > SEARCH_TOKENIZER_MAX_DOCUMENT_TERMS
          || nextTermBytes > SEARCH_TOKENIZER_MAX_TERM_BYTES
          || nextPositionBytes > SEARCH_TOKENIZER_MAX_POSITION_BYTES) {
        break;
      }
      documents.push({ ...tokenized, document: documents.length + 1 });
      nativeTokenCount = nextNativeTokens;
      distinctTermCount = nextDistinctTerms;
      termBytes = nextTermBytes;
      positionBytes = nextPositionBytes;
    }
    return {
      documents,
      acceptedDocumentCount: documents.length,
      nativeTokenCount,
      distinctTermCount,
      termBytes,
      positionBytes,
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #withRecovery<T>(work: () => T): T {
    if (this.#closed) throw tokenizerError('SEARCH_TOKENIZER_CLOSED');
    try {
      return work();
    } catch (error) {
      try {
        this.#db.close(false);
        this.#db = createTokenizerDatabase();
        const sourceId = String(
          this.#db.query<{ sourceId: string }, []>('SELECT fts5_source_id() AS sourceId').get()
            ?.sourceId ?? '',
        );
        if (sourceId !== this.sourceId) throw tokenizerError('SEARCH_TOKENIZER_UNSUPPORTED');
      } catch {
        this.#closed = true;
      }
      throw error;
    }
  }

  #tokenizeInstances(bodies: readonly string[], limits: InstanceLimits): VocabInstance[] {
    if (this.#closed) throw tokenizerError('SEARCH_TOKENIZER_CLOSED');
    let inserted = false;
    try {
      this.#db.exec('BEGIN');
      const insert = this.#db.query('INSERT INTO tokenizer_fts(rowid, body) VALUES (?, ?)');
      for (let index = 0; index < bodies.length; index += 1) {
        insert.run(index + 1, bodies[index]!);
      }
      this.#db.exec('COMMIT');
      inserted = true;
      const instances: VocabInstance[] = [];
      const documentTerms = new Set<string>();
      let termBytes = 0;
      const iterator = this.#db.query<VocabInstance, []>(`
        SELECT CAST(term AS BLOB) AS term, doc, col, offset FROM tokenizer_vocab
      `).iterate();
      try {
        for (const entry of iterator) {
          const instance = {
            term: Uint8Array.from(entry.term),
            doc: Number(entry.doc),
            col: String(entry.col),
            offset: Number(entry.offset),
          };
          if (!Number.isSafeInteger(instance.doc) || instance.doc < 1
              || instance.doc > bodies.length || instance.col !== 'body'
              || !Number.isSafeInteger(instance.offset) || instance.offset < 0
              || instance.term.byteLength === 0 || instance.term.byteLength > 32_768) {
            throw tokenizerError('SEARCH_TOKENIZER_INVALID');
          }
          const documentTerm = `${instance.doc}:${Buffer.from(instance.term).toString('hex')}`;
          const newDocumentTerm = !documentTerms.has(documentTerm);
          const nextTermBytes = termBytes + (
            limits.termBytes === 'occurrences' || newDocumentTerm ? instance.term.byteLength : 0
          );
          if (instances.length + 1 > limits.maxNativeTokens
              || (newDocumentTerm && documentTerms.size + 1 > limits.maxDocumentTerms)
              || nextTermBytes > limits.maxTermBytes) {
            throw tokenizerError(limits.errorCode);
          }
          instances.push(instance);
          if (newDocumentTerm) documentTerms.add(documentTerm);
          termBytes = nextTermBytes;
        }
      } finally {
        iterator.return?.();
      }
      return instances;
    } catch (error) {
      if (!inserted) {
        try { this.#db.exec('ROLLBACK'); } catch { /* The helper is recreated by the caller. */ }
      }
      throw error;
    } finally {
      if (inserted) {
        this.#db.exec("INSERT INTO tokenizer_fts(tokenizer_fts) VALUES ('delete-all')");
        const vocabCount = Number(
          this.#db.query<{ count: number }, []>('SELECT count(*) AS count FROM tokenizer_vocab')
            .get()?.count ?? -1,
        );
        const indexCount = Number(
          this.#db.query<{ count: number }, []>('SELECT count(*) AS count FROM tokenizer_fts_idx')
            .get()?.count ?? -1,
        );
        if (vocabCount !== 0 || indexCount !== 0) {
          throw tokenizerError('SEARCH_TOKENIZER_CLEANUP');
        }
        assertNoDiskPath(this.#db);
      }
    }
  }
}
