import { CodexSubagentToolUseMessage, ToolResultMessage, codexSubagentSourceFingerprint, parseChatMessage, type ChatMessage } from '../../../common/chat-types.js';
import { reduceSubagentMessage, resultString, subagentKnownAliases, type SubagentReductionEntry, type SubagentReductionPort } from '../../../common/subagent-management.js';
import { DisplayStore } from './store.js';

interface AuxiliaryControl { published: number; generation: number; building: number; relevant_through: number; phase: 'idle' | 'aliases' | 'reduce'; cursor: number; event_order: number }
interface Fact { ordinal: number; payload_json: string }

export function appendSubagentFact(store: DisplayStore, ordinal: number, message: ChatMessage | null): void {
  let relevant = false;
  if (message?.type === 'codex-subagent-tool-use') {
    store.run('INSERT INTO auxiliary_fact VALUES (?, ?, ?)', ordinal, 'use', JSON.stringify(message));
    store.run('INSERT OR IGNORE INTO auxiliary_tool VALUES (?)', message.toolId);
    relevant = true;
  } else if (message?.type === 'tool-result') {
    store.run('INSERT INTO auxiliary_result VALUES (?, ?, ?)', message.toolId, ordinal, JSON.stringify({
      isError: message.isError === true, agentId: resultString(message.content, 'agent_id') ?? null,
      nickname: resultString(message.content, 'nickname') ?? null,
    }));
    relevant = !!store.get('SELECT 1 FROM auxiliary_tool WHERE tool_id = ?', message.toolId);
  } else if (message?.type === 'user-message') {
    store.run('INSERT INTO auxiliary_fingerprint VALUES (?, ?)', codexSubagentSourceFingerprint(message.content), ordinal);
    relevant = !!store.get('SELECT 1 FROM auxiliary_tool LIMIT 1');
  }
  if (relevant) store.run('UPDATE auxiliary_control SET relevant_through = ?', ordinal);
}

export function prepareSubagentFrame(store: DisplayStore, goal: number): number {
  return store.db.transaction(() => {
    const control = store.get<AuxiliaryControl>('SELECT * FROM auxiliary_control')!;
    if (control.phase === 'idle') {
      if (control.published >= goal) return control.published;
      if (control.relevant_through <= control.published) {
        store.run('UPDATE auxiliary_control SET published = ?', goal);
        return goal;
      }
      control.building = goal; control.phase = 'aliases'; control.cursor = 0; control.event_order = 0;
    }
    const generation = control.building, port = reductionPort(store, generation);
    const facts = readFacts(store, control.cursor, generation);
    let bytes = 0, processed = 0;
    for (const fact of facts) {
      if (processed && bytes + fact.payload_json.length * 2 > 256 * 1024) break;
      const message = parseChatMessage(JSON.parse(fact.payload_json));
      if (!(message instanceof CodexSubagentToolUseMessage)) throw new Error('Invalid subagent fact');
      if (control.phase === 'aliases') {
        for (const alias of subagentKnownAliases(message, port.result(message.toolId))) {
          store.run('INSERT OR IGNORE INTO auxiliary_known_alias VALUES (?, ?)', generation, alias);
        }
      } else control.event_order = reduceSubagentMessage(port, message, fact.ordinal, control.event_order);
      control.cursor = fact.ordinal; bytes += fact.payload_json.length * 2; processed++;
    }
    if (!store.get('SELECT ordinal FROM auxiliary_fact INDEXED BY auxiliary_kind WHERE kind = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT 1', 'use', control.cursor, generation)) {
      control.cursor = 0;
      if (control.phase === 'aliases') control.phase = 'reduce';
      else { control.published = generation; control.generation = generation; control.phase = 'idle'; }
    }
    store.run('UPDATE auxiliary_control SET published = ?, generation = ?, building = ?, phase = ?, cursor = ?, event_order = ?',
      control.published, control.generation, generation, control.phase, control.cursor, control.event_order);
    return control.published;
  })();
}

function readFacts(store: DisplayStore, after: number, through: number): Fact[] {
  const query = store.db.prepare<Fact, [string, number, number]>(`SELECT ordinal, payload_json FROM auxiliary_fact INDEXED BY auxiliary_kind
    WHERE kind = ? AND ordinal > ? AND ordinal <= ? ORDER BY ordinal LIMIT 64`);
  const facts: Fact[] = [];
  let bytes = 0;
  try {
    for (const fact of query.iterate('use', after, through)) {
      facts.push(fact); bytes += fact.payload_json.length * 2;
      if (bytes >= 256 * 1024) break;
    }
    return facts;
  } finally { query.finalize(); }
}

export function pruneSubagentFrame(store: DisplayStore): boolean {
  const control = store.get<AuxiliaryControl>('SELECT * FROM auxiliary_control')!;
  for (const table of ['auxiliary_entry', 'auxiliary_alias', 'auxiliary_redirect', 'auxiliary_known_alias']) {
    const key = table === 'auxiliary_alias' || table === 'auxiliary_known_alias' ? 'alias' : 'entry_key';
    const rows = store.all<{ generation: number; key: string }>(`SELECT generation, ${key} AS key FROM ${table} WHERE generation < ? ORDER BY generation LIMIT 256`, control.generation);
    if (!rows.length) continue;
    store.db.transaction(() => {
      for (const row of rows) store.run(`DELETE FROM ${table} WHERE generation = ? AND ${key} = ?`, row.generation, row.key);
    })();
    return false;
  }
  return true;
}

function reductionPort(store: DisplayStore, generation: number): SubagentReductionPort {
  return {
    result(toolId) {
      const row = store.get<{ payload_json: string }>('SELECT payload_json FROM auxiliary_result WHERE tool_id = ? AND ordinal <= ? ORDER BY ordinal DESC LIMIT 1', toolId, generation);
      if (!row) return undefined;
      const result = JSON.parse(row.payload_json) as { isError: boolean; agentId: string | null; nickname: string | null };
      return new ToolResultMessage('', toolId, { agent_id: result.agentId, nickname: result.nickname }, result.isError);
    },
    knownAlias: alias => !!store.get('SELECT 1 FROM auxiliary_known_alias WHERE generation = ? AND alias = ?', generation, alias),
    userFingerprint: fingerprint => !!store.get('SELECT 1 FROM auxiliary_fingerprint WHERE fingerprint = ? AND ordinal <= ? LIMIT 1', fingerprint, generation),
    aliasKey(alias) {
      const row = store.get<{ entry_key: string }>('SELECT entry_key FROM auxiliary_alias WHERE generation = ? AND alias = ?', generation, alias);
      if (!row) return undefined;
      let key = row.entry_key;
      for (;;) {
        const redirect = store.get<{ target: string }>('SELECT target FROM auxiliary_redirect WHERE generation = ? AND entry_key = ?', generation, key);
        if (!redirect) break;
        key = redirect.target;
      }
      if (key !== row.entry_key) store.run('UPDATE auxiliary_alias SET entry_key = ? WHERE generation = ? AND alias = ?', key, generation, alias);
      return key;
    },
    setAlias: (alias, key) => store.run('INSERT INTO auxiliary_alias VALUES (?, ?, ?) ON CONFLICT(generation, alias) DO UPDATE SET entry_key = excluded.entry_key', generation, alias, key),
    entry(key) {
      const row = store.get<{ payload_json: string }>('SELECT payload_json FROM auxiliary_entry WHERE generation = ? AND entry_key = ?', generation, key);
      return row ? JSON.parse(row.payload_json) as SubagentReductionEntry : undefined;
    },
    write(value) {
      store.run('INSERT INTO auxiliary_entry VALUES (?, ?, ?, ?) ON CONFLICT(generation, entry_key) DO UPDATE SET payload_json = excluded.payload_json',
        generation, value.entry.id, value.createdOrder, JSON.stringify(value));
    },
    merge(duplicate, primary) {
      store.run('INSERT INTO auxiliary_redirect VALUES (?, ?, ?)', generation, duplicate, primary);
      store.run('DELETE FROM auxiliary_entry WHERE generation = ? AND entry_key = ?', generation, duplicate);
    },
  };
}
