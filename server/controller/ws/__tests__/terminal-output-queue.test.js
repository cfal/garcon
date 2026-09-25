import { describe, expect, it } from "bun:test";
import { serializeTerminalMessage } from '../../../common/terminal-framing.ts';
import { TerminalOutputQueue } from '../terminal-output-queue.ts';

function output(terminalId, sequence, data = "output") {
  return { type: "terminal-output", terminalId, sequence, data };
}

function enqueue(queue, message) {
  return queue.enqueue(message, serializeTerminalMessage(message));
}

describe("TerminalOutputQueue", () => {
  it('does not clear replacement-attachment output during stale cleanup', () => {
    const queue = new TerminalOutputQueue();
    enqueue(queue, { ...output('terminal', 1), attachmentId: 'old' });
    enqueue(queue, { ...output('terminal', 2), attachmentId: 'new' });
    queue.clearSession('terminal', 'old');
    expect(JSON.parse(queue.next().payload).attachmentId).toBe('new');
    expect(queue.next()).toBeNull();
  });
  it("clears only one terminal and preserves fair delivery for the others", () => {
    const queue = new TerminalOutputQueue();
    enqueue(queue, output("terminal-1", 1));
    enqueue(queue, output("terminal-1", 2));
    enqueue(queue, output("terminal-2", 1));
    enqueue(queue, output("terminal-3", 1));

    queue.clearSession("terminal-1");

    expect(JSON.parse(queue.next().payload)).toMatchObject({
      terminalId: "terminal-2",
      sequence: 1,
    });
    expect(JSON.parse(queue.next().payload)).toMatchObject({
      terminalId: "terminal-3",
      sequence: 1,
    });
    expect(queue.next()).toBeNull();
  });

  it("keeps rotation bookkeeping valid when clearing before the current index", () => {
    const queue = new TerminalOutputQueue();
    enqueue(queue, output("terminal-1", 1));
    enqueue(queue, output("terminal-1", 2));
    enqueue(queue, output("terminal-2", 1));
    enqueue(queue, output("terminal-2", 2));
    enqueue(queue, output("terminal-3", 1));

    expect(JSON.parse(queue.next().payload).terminalId).toBe("terminal-1");
    queue.clearSession("terminal-1");

    expect(JSON.parse(queue.next().payload).terminalId).toBe("terminal-2");
    expect(JSON.parse(queue.next().payload).terminalId).toBe("terminal-3");
    expect(JSON.parse(queue.next().payload).terminalId).toBe("terminal-2");
  });
});
