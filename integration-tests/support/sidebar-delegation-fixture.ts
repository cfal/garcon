import type { ChatMessagesMessage } from '../../common/ws-events.js';
import type { IntegrationFixture } from './integration-fixture.js';

export async function createSidebarDelegationFixture(fixture: IntegrationFixture) {
  const roots = [fixture.newChatId(), fixture.newChatId()];
  const children: string[][] = [];
  for (const [index, root] of roots.entries()) {
    const prompt = `Synthetic branch ${index}`;
    const refs = index === 0 ? ['first', 'second'] : ['third'];
    const held = fixture.fakeProviders.openAi.holdNext({ lastUserText: prompt });
    const cursor = fixture.client.markEvents();
    const started = await fixture.client.startDirectChat({
      chatId: root, content: prompt, projectPath: fixture.dirs.project, agent: fixture.directAgents.openAi,
    });
    await held.received;
    held.releaseText(refs.map((ref) => `<garcon-start-agent ref="${ref}" async="true" title="Synthetic ${ref} child">Synthetic ${ref} task.</garcon-start-agent>`).join('\n'));
    const ids: string[] = [];
    for (const ref of refs) {
      const event = await fixture.client.waitForEvent(
        (event): event is ChatMessagesMessage => event.type === 'chat-messages' && event.chatId === root
          && event.messages.some(({ message }) => message.type === 'transcript-notice'
            && message.detail?.type === 'agent-start-outcome' && message.detail.ref === ref && message.detail.status === 'accepted'),
        `sidebar delegation ${ref}`, { afterIndex: cursor },
      );
      const detail = event.messages.flatMap(({ message }) => message.type === 'transcript-notice'
        && message.detail?.type === 'agent-start-outcome' && message.detail.ref === ref ? [message.detail] : [])[0];
      if (detail?.status !== 'accepted') throw new Error('Missing synthetic child');
      ids.push(detail.chatId);
      await fixture.client.waitForTurnTerminal(detail.chatId, undefined, { afterIndex: cursor });
    }
    await fixture.client.waitForTurnTerminal(root, started.turnId, { afterIndex: cursor });
    children.push(ids);
  }
  const [a, b] = roots;
  const [a1, a2] = children[0]!;
  const [b1] = children[1]!;
  if (!a || !b || !a1 || !a2 || !b1) throw new Error('Incomplete synthetic sidebar forest');
  const canonical = [a1, b, a, b1, a2];
  for (const chatId of [...canonical].reverse()) {
    await fixture.client.reorderChat({ chatId, placement: { kind: 'boundary', boundary: 'top' } });
  }
  return { a, b, a1, a2, b1, canonical };
}
