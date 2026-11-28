import crypto from 'node:crypto';
import { ChatExecutionControlOperations } from '../../../../server/controller/chat-execution/chat-execution-control-operations.ts';
import { InMemoryChatExecutionControlRepository } from '../../../../server/controller/chat-execution/chat-execution-control-repository.ts';
import { DomainError, ProjectUnavailableError } from '../../../../server/common/domain-error.ts';

type Step = [string, ...any[]];

export async function controlOperationsTrace(steps: Step[]) {
  const originalDate = globalThis.Date;
  const originalUuid = crypto.randomUUID;
  let idCalls = 0;
  let exists = true;
  let projectAvailable = true;
  let attachmentSupported = true;
  let publishWorks = true;
  globalThis.Date = class extends originalDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(args.length === 0 ? 60_123 : args[0] as number);
    }
    static now() { return 60_123; }
  } as typeof Date;
  crypto.randomUUID = (() => `id-${++idCalls}`) as typeof originalUuid;
  try {
    const repository = new InMemoryChatExecutionControlRepository('server');
    const effects: unknown[][] = [];
    const operations = new ChatExecutionControlOperations(repository, {
      runExclusive: (_chat, run) => run(),
      chatExists(chat) { effects.push(['exists', chat]); return exists; },
      unsettledQueueReceiptKeys(chat) { effects.push(['receipt-keys', chat]); return new Set(); },
      publish(chat, control) {
        effects.push(['publish', chat, control.version, repository.load(chat).version]);
        if (!publishWorks) throw new Error('listener failed');
      },
      inputAccepted(chat) { effects.push(['accepted', chat]); },
    }, {
      async assertAvailable(chat, deadline) {
        effects.push(['project', chat, deadline]);
        if (!projectAvailable) throw new ProjectUnavailableError('/workspace/missing', 'not-found');
      },
    }, {
      assertSupported(chat, images) {
        effects.push(['attachments', chat, images.length]);
        if (!attachmentSupported) throw new DomainError('UNSUPPORTED_AGENT', 'Attachments unsupported', 422);
      },
    });
    const results: unknown[] = [];
    for (const [name, ...args] of steps) {
      try {
        let result: unknown;
        switch (name) {
          case 'exists': exists = args[0]; break;
          case 'projectAvailable': projectAvailable = args[0]; break;
          case 'attachmentSupported': attachmentSupported = args[0]; break;
          case 'publishWorks': publishWorks = args[0]; break;
          case 'dequeueNextTurn': result = await operations.dequeueNextTurn(args[0], input => {
            effects.push(['admit', args[0], input.kind, input.entry.id]);
            if (args[1] === 'throw') throw new Error('admission failed');
            return args[1];
          }); break;
          case 'withControl': result = await operations.withControl(args[0], async control => control); break;
          default: result = await (operations as any)[name](...args);
        }
        results.push(result ?? null);
      } catch (error) {
        const { name, message, code, status, control } = error as DomainError & { control?: unknown };
        results.push({ error: { name, message, code: code ?? null, status: status ?? null, control: control ?? null } });
      }
    }
    return { results, effects, idCalls };
  } finally {
    globalThis.Date = originalDate;
    crypto.randomUUID = originalUuid;
  }
}
