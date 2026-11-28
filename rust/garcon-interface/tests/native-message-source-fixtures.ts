import {
  attachNativeMessageSource,
  attachNativeSourceToMessages,
  getNativeMessageRevisionSource,
  getNativeMessageSource,
  type NativeMessageSource,
} from '../../../server-agents/interface/src/native-message-source.ts';
import { UserMessage } from '../../../common/chat-types.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, got ${Bun.version}`);

const fixtures: (NativeMessageSource | null)[][] = [
  [],
  [{ lineNumber: 1, byteOffset: 0 }],
  [{ withinSourceOrdinal: 0 }],
  [{ entryId: '  native-id  ', lineNumber: 1e21, byteOffset: 9007199254740991, withinSourceOrdinal: 4 }],
  [{ entryId: '\uFEFF\u00A0', byteOffset: -1, withinSourceOrdinal: 0.5, lineNumber: 0 }],
  [{ entryId: 'kept' }, { entryId: '', lineNumber: 0.5, byteOffset: 9007199254740992 }, null],
  [{ entryId: 'old', lineNumber: 1 }, { lineNumber: 2, byteOffset: -1 }],
];

for (const sources of fixtures) {
  const messages = [
    new UserMessage('2026-01-01T00:00:00.000Z', 'first'),
    new UserMessage('2026-01-01T00:00:01.000Z', 'second'),
  ];
  if (sources.length > 0) {
    attachNativeMessageSource(messages[0], sources[0]);
    attachNativeSourceToMessages(messages.slice(1), sources[0]);
  }
  for (const source of sources.slice(1)) attachNativeSourceToMessages(messages, source);
  console.log(JSON.stringify({
    sources,
    messages,
    public: messages.map(getNativeMessageSource),
    revision: messages.map(getNativeMessageRevisionSource),
  }));
}
