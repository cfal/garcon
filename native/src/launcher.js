/**
 * @typedef {object} ServerChoices
 * @property {number} generation
 * @property {{url: string, name: string | null}[]} recents
 * @property {string | null} lastUrl
 * @property {string | null} currentUrl
 * @property {boolean} canCancel
 * @property {{id: number, server: string, url: string, message: string | null, canRetry: boolean, canShow: boolean} | null} connection
 */
export async function mountLauncher(document, invoke) {
  const form = document.querySelector('#server-form');
  const input = document.querySelector('#server-url');
  const insecureEndpoint = document.querySelector('#insecure-endpoint');
  const name = document.querySelector('#server-name');
  const add = document.querySelector('#add-server');
  const error = document.querySelector('#connection-error');
  const recents = document.querySelector('#recent-servers');
  const cancel = document.querySelector('#cancel');
  const current = document.querySelector('#current-server');
  const selection = document.querySelector('#server-selection');
  const connection = document.querySelector('#connection');
  const retryConnection = document.querySelector('#retry-connection');
  const cancelConnection = document.querySelector('#cancel-connection');
  const showConnection = document.querySelector('#show-connection');
  /** @type {ServerChoices | undefined} */
  let choices;
  let pending = false;
  let ready = false;
  let refreshId = 0;
  let refreshRequested = false;

  function updateEndpointWarning() {
    try {
      insecureEndpoint.hidden = new URL(input.value.trim()).protocol !== 'http:';
    } catch {
      insecureEndpoint.hidden = true;
    }
  }

  function savedName(value) {
    try {
      const url = new URL(value.trim());
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return choices?.recents.find(server => server.url === url.href)?.name ?? '';
    } catch {
      return '';
    }
  }

  function setPending(value) {
    pending = value;
    for (const control of document.querySelectorAll('button, input')) control.disabled = value || !ready;
    if (choices?.connection) {
      for (const control of selection.querySelectorAll('button, input')) control.disabled = true;
      retryConnection.disabled ||= !choices.connection.canRetry;
      showConnection.disabled ||= !choices.connection.canShow;
    }
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
      selection.hidden = !!choices.connection;
      connection.hidden = !choices.connection;
      if (choices.connection) {
        document.querySelector('#connection-heading').textContent = choices.connection.message ? 'Connection not ready' : 'Connecting';
        document.querySelector('#connection-server').textContent = choices.connection.server;
        document.querySelector('#connection-url').textContent = choices.connection.url;
        document.querySelector('#connection-status').textContent = choices.connection.message ?? 'Waiting for Garcon...';
        showConnection.hidden = !choices.connection.canShow;
      }
      input.value = choices.lastUrl ?? '';
      updateEndpointWarning();
      name.value = savedName(input.value);
      current.textContent = choices.currentUrl ? `Opened from: ${choices.currentUrl}` : '';
      cancel.hidden = !choices.canCancel;
      recents.replaceChildren();
      for (const server of choices.recents) {
        const { url } = server;
        const row = document.createElement('li');
        const select = document.createElement('button');
        select.type = 'button';
        select.textContent = server.name ?? url;
        if (server.name) {
          const address = document.createElement('small');
          address.textContent = url;
          select.append(address);
        }
        if (url === choices.currentUrl) select.setAttribute('aria-current', 'true');
        select.addEventListener('click', () => {
          input.value = url;
          updateEndpointWarning();
          name.value = server.name ?? '';
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
      ready = true;
      setPending(false);
    } catch (cause) {
      if (id !== refreshId) return;
      error.textContent = typeof cause === 'string' ? cause : 'Unable to read saved server settings. Restart the app to retry.';
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!ready || pending || choices?.connection || !form.reportValidity()) return;
    const attemptedUrl = input.value;
    const attemptedName = name.value;
    await run(() => invoke('connect_server', { url: attemptedUrl, name: attemptedName, generation: choices.generation }));
    if (error.textContent) {
      const message = error.textContent;
      await refresh();
      input.value = attemptedUrl;
      updateEndpointWarning();
      name.value = attemptedName;
      error.textContent = message;
    }
  });

  input.addEventListener('input', () => {
    name.value = savedName(input.value);
    updateEndpointWarning();
  });
  input.addEventListener('change', updateEndpointWarning);
  add.addEventListener('click', () => {
    input.value = '';
    updateEndpointWarning();
    name.value = '';
    input.focus();
  });
  cancel.addEventListener('click', () => void run(() => invoke('cancel_chooser', { generation: choices.generation })));
  for (const [button, command] of [
    [retryConnection, 'retry_connection'],
    [cancelConnection, 'cancel_connection'],
    [showConnection, 'show_connection'],
  ]) {
    button.addEventListener('click', () => {
      if (choices?.connection) void run(() => invoke(command, { id: choices.connection.id }));
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (choices?.connection) cancelConnection.click();
    else if (choices?.canCancel) cancel.click();
  });
  document.defaultView.addEventListener('garcon-chooser-open', () => void refresh());
  await refresh();
}
