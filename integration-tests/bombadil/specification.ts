import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction, type ActionTemplate } from '@antithesishq/bombadil/browser';
import { bootstrap, commandPanel, findControl, observerKey, requireTarget, visible, type BrowserConfig, type Control } from './browser.ts';
import { completedWorkflow, uniqueQueueEntries, validPanels } from './properties.ts';

export function createSpecification(config: BrowserConfig) {
  bootstrap(config);
  const observation = extract(({ document, window, lastAction }) => {
    const panel = commandPanel(document);
    const composer = findControl(document, config, 'composer') as HTMLTextAreaElement | null;
    const editor = findControl(document, config, 'editor') as HTMLTextAreaElement | null;
    const controls = (['chatA', 'chatB', 'composer', 'send', 'queue', 'stop', 'edit', 'editor', 'save', 'menu', 'remove'] as const)
      .filter(control => {
        try { requireTarget(document, findControl(document, config, control)); return true; }
        catch { return false; }
      });
    const chatId = panel?.getAttribute('data-conversation-panel-chat-id') ?? '';
    const sentinel = chatId === config.chatA ? 'echo:bombadilalpha' : chatId === config.chatB ? 'echo:bombadilbravo' : null;
    const ready = !!panel?.querySelector('[data-chat-scroll-viewport][aria-busy="false"]') && !!composer
      && !!panel.querySelector('[data-chat-row-id]') && sentinel !== null && panel.textContent?.includes(sentinel) === true;
    return {
      ...window.__bombadil!,
      complete: completedWorkflow(window.__bombadil, ready),
      chatId,
      ready,
      pressedEnter: typeof lastAction === 'object' && lastAction !== null && 'PressKey' in lastAction && lastAction.PressKey.code === 13,
      composer: composer?.value.slice(0, 256) ?? '', editor: editor?.value.slice(0, 256) ?? '',
      composerSelected: composer?.selectionStart === 0 && composer.selectionEnd === composer.value.length,
      editorSelected: editor?.selectionStart === 0 && editor.selectionEnd === editor.value.length,
      inputBounded: (composer?.value.length ?? 0) < 256 && (editor?.value.length ?? 0) < 256,
      focused: document.activeElement === editor ? 'editor' : document.activeElement === composer ? 'composer' : '',
      controls,
      panels: Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-panel]')).filter(visible).map(element => ({
        chatId: element.getAttribute('data-conversation-panel-chat-id') ?? '',
        rows: Array.from(element.querySelectorAll('[data-chat-row-id]')).map(row => row.getAttribute('data-chat-row-id')!),
        text: element.textContent?.slice(0, 20_000) ?? '',
      })),
      queues: Array.from(document.querySelectorAll('[data-queue-status-summary]')).filter(visible).map(queue =>
        Array.from(queue.querySelectorAll('[data-queue-entry-id]')).map(row => row.getAttribute('data-queue-entry-id')!)),
      queueText: panel?.querySelector('[data-queue-status-summary]')?.textContent?.slice(0, 2_000) ?? '',
    };
  });
  const checkpoint = registerCustomAction('garcon-checkpoint', async (_document, window, stage: number) => {
    window.__bombadil!.stage = stage;
    window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
  });
  const prepareReload = registerCustomAction('garcon-prepare-reload', async (_document, window, stage: number) => {
    window.__bombadil!.reloadBaseline = window.__bombadil!.documents;
    window.__bombadil!.stage = stage;
    window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
  });
  const activate = registerCustomAction('garcon-control', async (document, window, control: Control, stage: number) => {
    try {
      if (control !== 'chatA' && control !== 'chatB'
        && commandPanel(document)?.getAttribute('data-conversation-panel-chat-id') !== config.chatA) {
        throw new Error('Command owner changed');
      }
      const element = requireTarget(document, findControl(document, config, control));
      if (control === 'composer' || control === 'editor') {
        element.focus();
        (element as HTMLTextAreaElement).select();
      } else element.click();
      window.__bombadil!.stage = stage;
    } catch (error) {
      if (window.__bombadil!.actionErrors.length < 20) window.__bombadil!.actionErrors.push(String(error));
    }
    window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
  });
  const explore = registerCustomAction('garcon-explore', async (document, window, choice: 'chatA' | 'chatB' | 'scroll') => {
    try {
      if (choice === 'scroll') {
        const viewport = commandPanel(document)?.querySelector('[data-chat-scroll-viewport]');
        if (!viewport) throw new Error('Missing transcript viewport');
        const before = viewport.scrollTop;
        viewport.scrollTop = viewport.scrollTop > 0 ? 0 : viewport.scrollHeight;
        if (Math.abs(viewport.scrollTop - before) > 1) window.__bombadil!.scrollChanges++;
      } else requireTarget(document, findControl(document, config, choice)).click();
      window.__bombadil!.randomActions++;
    } catch (error) { window.__bombadil!.actionErrors.push(String(error)); }
    window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
  });
  const finish = registerCustomAction('garcon-complete', async (_document, window) => {
    window.__bombadil!.complete = true;
    window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
  });

  type Snapshot = typeof observation.current;
  type Step = (snapshot: Snapshot, next: number) => ActionTemplate[];
  const wait = (predicate: (snapshot: Snapshot) => boolean): Step => (snapshot, next) => predicate(snapshot) ? [checkpoint(next)] : ['Wait'];
  const click = (control: Control): Step => (snapshot, next) => snapshot.controls.includes(control) ? [activate(control, next)] : ['Wait'];
  const text = (value: string, target: 'composer' | 'editor' = 'composer'): Step => snapshot => {
    if (snapshot[target] === value) return [checkpoint(snapshot.stage + 1)];
    if (snapshot.focused !== target || (snapshot[target] !== '' && !snapshot[`${target}Selected`])) return [activate(target, snapshot.stage)];
    return [{ TypeText: { text: { Regexp: value } } }];
  };
  const ready = (chatId: string) => (snapshot: Snapshot) => snapshot.ready && snapshot.chatId === chatId && snapshot.documentWsOpen;
  const hasReply = (prompt: string) => (snapshot: Snapshot) => snapshot.panels.some(panel => panel.chatId === config.chatA
    && panel.text.replace(/\s/g, '').includes(`echo:${prompt}`.replace(/\s/g, '')));
  const steps: Step[] = [
    wait(ready(config.chatA)), click('chatB'), wait(ready(config.chatB)), click('chatA'), wait(ready(config.chatA)),
    // The checkpoint survives Reload; document count proves that a new document was observed.
    (_snapshot, next) => [prepareReload(next)],
    snapshot => snapshot.documents <= snapshot.reloadBaseline ? ['Reload'] : [checkpoint(snapshot.stage + 1)],
    wait(ready(config.chatA)),
    (snapshot, next) => snapshot.scrollChanges > 0 ? [checkpoint(next)] : [explore('scroll')],
  ];
  if (config.campaign === 'submission') {
    steps.push(text('bombadilclick'), click('send'), wait(hasReply('bombadilclick')),
      text('bombadilenter'), snapshot => {
        if (snapshot.pressedEnter) return [checkpoint(snapshot.stage + 1)];
        return snapshot.composer === 'bombadilenter' && snapshot.focused === 'composer' && snapshot.controls.includes('send')
          ? [{ PressKey: { code: 13 } }] : ['Wait'];
      }, wait(hasReply('bombadilenter')));
  }
  if (config.campaign === 'queue') {
    steps.push(text('bombadilqueued'), click('queue'), wait(snapshot => snapshot.queueText.includes('bombadilqueued')),
      click('edit'), wait(snapshot => snapshot.controls.includes('editor')), text('bombadiledited', 'editor'), click('save'),
      wait(snapshot => snapshot.queueText.includes('bombadiledited')), click('menu'), click('remove'),
      wait(snapshot => snapshot.queues.every(queue => queue.length === 0)), click('stop'),
      wait(snapshot => !snapshot.controls.includes('stop')), text('bombadilafterstop'), click('send'), wait(hasReply('bombadilheld\n\nbombadilafterstop')));
  }
  return {
    properties: always(() => observation.current.inputBounded && observation.current.apiErrors?.length === 0 && observation.current.actionErrors?.length === 0
      && validPanels(observation.current.panels, config.chatA, config.chatB) && uniqueQueueEntries(observation.current.queues)),
    actions: actions(() => {
      const snapshot = observation.current;
      if (snapshot.stage < steps.length) return steps[snapshot.stage](snapshot, snapshot.stage + 1);
      if (!ready(snapshot.chatId)(snapshot) || snapshot.complete) return ['Wait'];
      if (snapshot.randomActions >= 30) return [finish()];
      return ['Wait', explore('scroll'), ...(['chatA', 'chatB'] as const)
        .filter(control => snapshot.controls.includes(control)).map(control => explore(control))];
    }),
  };
}
