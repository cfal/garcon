import {
  convertCodexAppServerLiveItem as live,
  convertCodexRawCodeModeItem as raw,
} from '../../../../server-agents/codex/src/agents/codex/app-server/converter.ts';

const timestamp = '2026-02-21T10:00:00.000Z';

export function liveItems(items: Parameters<typeof live>[0][], trigger?: Parameters<typeof live>[2]) {
  return JSON.parse(JSON.stringify(items.map(item => live(item, timestamp, trigger))));
}

export function rawItems(items: Parameters<typeof raw>[0][], entries: [string, string][] = []) {
  const pending = new Map(entries);
  const messages = items.map(item => raw(item, timestamp, pending));
  return JSON.parse(JSON.stringify({ messages, pending: [...pending] }));
}
