import { always } from '@antithesishq/bombadil';
import { actions, extract, registerCustomAction, type ActionTemplate } from '@antithesishq/bombadil/browser';
import { bootstrap, commandPanel, controlNames, findControl, observerKey, requireTarget, visible, type BrowserConfig, type Control } from './browser.ts';
import { completedWorkflow, uniqueQueueEntries, validPanels } from './properties.ts';

function persistObservation(window: Window): void {
  window.sessionStorage.setItem(observerKey, JSON.stringify(window.__bombadil));
}

export function createSpecification(config: BrowserConfig) {
  bootstrap(config);
  const observation = extract(({ document, window, lastAction }) => {
    const panel = commandPanel(document);
    const composer = findControl(document, config, 'composer') as HTMLTextAreaElement | null;
    const editor = findControl(document, config, 'editor') as HTMLTextAreaElement | null;
    const controls = controlNames.filter(control => {
      try {
        requireTarget(document, findControl(document, config, control));
        return true;
      } catch {
        return false;
      }
    });
    const chatId = panel?.getAttribute('data-conversation-panel-chat-id') ?? '';
    let sentinel: string | null = null;
    if (chatId === config.chatA) sentinel = 'echo:bombadilalpha';
    else if (chatId === config.chatB) sentinel = 'echo:bombadilbravo';
    const ready = !!panel?.querySelector('[data-chat-scroll-viewport][aria-busy="false"]') && !!composer
      && !!panel.querySelector('[data-chat-row-id]') && sentinel !== null && panel.textContent?.includes(sentinel) === true;
    let focused = '';
    if (document.activeElement === editor) focused = 'editor';
    else if (document.activeElement === composer) focused = 'composer';
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
      focused,
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
    persistObservation(window);
  });
  const prepareReload = registerCustomAction('garcon-prepare-reload', async (_document, window, stage: number) => {
    const progress = window.__bombadil!;
    progress.reloadBaseline = progress.documents;
    progress.stage = stage;
    persistObservation(window);
  });
  const activate = registerCustomAction('garcon-control', async (document, window, control: Control, stage: number) => {
    const progress = window.__bombadil!;
    try {
      if (control !== 'chatA' && control !== 'chatB'
        && commandPanel(document)?.getAttribute('data-conversation-panel-chat-id') !== config.chatA) {
        throw new Error('Command owner changed');
      }
      const element = requireTarget(document, findControl(document, config, control));
      if (control === 'composer' || control === 'editor') {
        element.focus();
        (element as HTMLTextAreaElement).select();
      } else {
        element.click();
      }
      progress.stage = stage;
    } catch (error) {
      if (progress.actionErrors.length < 20) progress.actionErrors.push(String(error));
    }
    persistObservation(window);
  });
  const explore = registerCustomAction('garcon-explore', async (document, window, choice: 'chatA' | 'chatB' | 'scroll') => {
    const progress = window.__bombadil!;
    try {
      if (choice === 'scroll') {
        const viewport = commandPanel(document)?.querySelector('[data-chat-scroll-viewport]');
        if (!viewport) throw new Error('Missing transcript viewport');
        const before = viewport.scrollTop;
        viewport.scrollTop = viewport.scrollTop > 0 ? 0 : viewport.scrollHeight;
        if (Math.abs(viewport.scrollTop - before) > 1) progress.scrollChanges++;
      } else {
        requireTarget(document, findControl(document, config, choice)).click();
      }
      if (progress.stage >= steps.length) progress.randomActions++;
    } catch (error) {
      progress.actionErrors.push(String(error));
    }
    persistObservation(window);
  });
  const finish = registerCustomAction('garcon-complete', async (_document, window) => {
    window.__bombadil!.complete = true;
    persistObservation(window);
  });

  type Snapshot = typeof observation.current;
  type Step = (snapshot: Snapshot, next: number) => ActionTemplate[];
  const waitUntil = (predicate: (snapshot: Snapshot) => boolean): Step => (snapshot, next) =>
    predicate(snapshot) ? [checkpoint(next)] : ['Wait'];
  const click = (control: Control): Step => (snapshot, next) =>
    snapshot.controls.includes(control) ? [activate(control, next)] : ['Wait'];
  const enterText = (value: string, target: 'composer' | 'editor' = 'composer'): Step => (snapshot, next) => {
    if (snapshot[target] === value) return [checkpoint(next)];
    if (snapshot.focused !== target || (snapshot[target] !== '' && !snapshot[`${target}Selected`])) {
      return [activate(target, snapshot.stage)];
    }
    return [{ TypeText: { text: { Regexp: value } } }];
  };
  const readyFor = (chatId: string) => (snapshot: Snapshot) => snapshot.ready && snapshot.chatId === chatId && snapshot.documentWsOpen;
  const hasReply = (prompt: string) => (snapshot: Snapshot) => snapshot.panels.some(panel => panel.chatId === config.chatA
    && panel.text.replace(/\s/g, '').includes(`echo:${prompt}`.replace(/\s/g, '')));
  const steps: Step[] = [
    waitUntil(readyFor(config.chatA)),
    click('chatB'),
    waitUntil(readyFor(config.chatB)),
    click('chatA'),
    waitUntil(readyFor(config.chatA)),
    // The checkpoint survives Reload; document count proves that a new document was observed.
    (_snapshot, next) => [prepareReload(next)],
    (snapshot, next) => snapshot.documents <= snapshot.reloadBaseline ? ['Reload'] : [checkpoint(next)],
    waitUntil(readyFor(config.chatA)),
    (snapshot, next) => snapshot.scrollChanges > 0 ? [checkpoint(next)] : [explore('scroll')],
  ];
  if (config.campaign === 'submission') {
    steps.push(
      enterText('bombadilclick'),
      click('send'),
      waitUntil(hasReply('bombadilclick')),
      enterText('bombadilenter'),
      (snapshot, next) => {
        if (snapshot.pressedEnter) return [checkpoint(next)];
        if (snapshot.composer === 'bombadilenter' && snapshot.focused === 'composer' && snapshot.controls.includes('send')) {
          return [{ PressKey: { code: 13 } }];
        }
        return ['Wait'];
      },
      waitUntil(hasReply('bombadilenter')),
    );
  }
  if (config.campaign === 'queue') {
    steps.push(
      enterText('bombadilqueued'),
      click('queue'),
      waitUntil(snapshot => snapshot.queueText.includes('bombadilqueued')),
      click('edit'),
      waitUntil(snapshot => snapshot.controls.includes('editor')),
      enterText('bombadiledited', 'editor'),
      click('save'),
      waitUntil(snapshot => snapshot.queueText.includes('bombadiledited')),
      click('menu'),
      click('remove'),
      waitUntil(snapshot => snapshot.queues.every(queue => queue.length === 0)),
      click('stop'),
      waitUntil(snapshot => !snapshot.controls.includes('stop')),
      enterText('bombadilafterstop'),
      click('send'),
      waitUntil(hasReply('bombadilheld\n\nbombadilafterstop')),
    );
  }
  return {
    properties: always(() => {
      const snapshot = observation.current;
      return snapshot.inputBounded && snapshot.apiErrors?.length === 0 && snapshot.actionErrors?.length === 0
        && validPanels(snapshot.panels, config.chatA, config.chatB) && uniqueQueueEntries(snapshot.queues);
    }),
    actions: actions(() => {
      const snapshot = observation.current;
      if (snapshot.stage < steps.length) return steps[snapshot.stage](snapshot, snapshot.stage + 1);
      if (!snapshot.ready || !snapshot.documentWsOpen || snapshot.complete) return ['Wait'];
      if (snapshot.randomActions >= 30) return [finish()];
      return ['Wait', explore('scroll'), ...(['chatA', 'chatB'] as const)
        .filter(control => snapshot.controls.includes(control)).map(control => explore(control))];
    }),
  };
}
