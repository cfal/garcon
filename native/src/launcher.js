/**
 * @typedef {object} ServerChoices
 * @property {number} generation
 * @property {string[]} recents
 * @property {string | null} lastUrl
 * @property {string | null} currentUrl
 * @property {boolean} canCancel
 * @property {boolean} pending
 * @property {'switch' | 'reload'} action
 */
export async function mountLauncher(document, invoke) {
  const form = document.querySelector('#server-form');
  const input = document.querySelector('#server-url');
  const button = form.querySelector('button[type=submit]');
  const error = document.querySelector('#connection-error');
  const recents = document.querySelector('#recent-servers');
  const cancel = document.querySelector('#cancel');
  const acknowledgement = document.querySelector('#acknowledged');
  const warning = document.querySelector('#switch-warning');
  const current = document.querySelector('#current-server');
  /** @type {ServerChoices | undefined} */
  let choices;
  let pending = false;
  let ready = false;
  let refreshId = 0;
  let refreshRequested = false;

  function setPending(value) {
    pending = value;
    for (const control of document.querySelectorAll('button, input')) control.disabled = value || !ready;
  }

  async function run(operation) {
    if (!ready || pending) return;
    setPending(true);
    error.textContent = '';
    try { await operation(); }
    catch (cause) { error.textContent = typeof cause === 'string' ? cause : 'Unable to complete the server action.'; }
    finally {
      setPending(false);
      if (refreshRequested) {
        refreshRequested = false;
        const message = error.textContent;
        await refresh();
        if (message) error.textContent = message;
      }
    }
  }

  async function refresh() {
    if (pending) { refreshRequested = true; return; }
    const id = ++refreshId;
    ready = false;
    setPending(false);
    error.textContent = '';
    try {
      const result = await invoke('server_choices');
      if (id !== refreshId) return;
      choices = result;
      input.value = (choices.action === 'reload' ? choices.currentUrl : choices.lastUrl) ?? '';
      current.textContent = choices.currentUrl ? `Current: ${choices.currentUrl}` : '';
      cancel.hidden = !choices.canCancel;
      warning.hidden = !choices.currentUrl;
      acknowledgement.checked = false;
      acknowledgement.required = !!choices.currentUrl;
      button.textContent = choices.action === 'reload' ? 'Reload Server' : choices.currentUrl ? 'Switch Server' : 'Connect';
      recents.replaceChildren();
      for (const url of choices.recents) {
        const row = document.createElement('li');
        const select = document.createElement('button');
        select.type = 'button';
        select.textContent = url;
        if (url === choices.currentUrl) select.setAttribute('aria-current', 'true');
        select.addEventListener('click', () => {
          input.value = url;
          button.textContent = url === choices.currentUrl ? 'Reload Server' : 'Switch Server';
          acknowledgement.checked = false;
          input.focus();
        });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '-';
        remove.title = 'Remove from recents';
        remove.setAttribute('aria-label', `Remove ${url} from recents`);
        remove.addEventListener('click', async () => {
          await run(() => invoke('remove_recent', { url, generation: choices.generation }));
          if (!error.textContent) await refresh();
        });
        row.append(select, remove);
        recents.append(row);
      }
      ready = !choices.pending;
      setPending(false);
    } catch (cause) {
      error.textContent = typeof cause === 'string' ? cause : 'Unable to read saved server settings. Restart the app to retry.';
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || pending || !form.reportValidity()) return;
    await run(() => invoke('connect_server', { url: input.value, generation: choices.generation, acknowledged: acknowledgement.checked }));
    if (error.textContent) {
      const message = error.textContent;
      const attemptedUrl = input.value;
      await refresh();
      input.value = attemptedUrl;
      error.textContent = message;
    }
  });

  document.querySelector('#add-server').addEventListener('click', () => {
    input.value = '';
    acknowledgement.checked = false;
    button.textContent = choices.currentUrl ? 'Switch Server' : 'Connect';
    input.focus();
  });
  cancel.addEventListener('click', () => void run(() => invoke('cancel_chooser', { generation: choices.generation })));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && choices?.canCancel) cancel.click();
  });
  document.defaultView.addEventListener('garcon-chooser-open', () => void refresh());
  await refresh();
}
