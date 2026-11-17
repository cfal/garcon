import type { AgentRunCommandRequest, AgentTurnCommandResponse } from '../../common/chat-command-contracts.js';

export type Campaign = 'navigation' | 'submission' | 'queue';
export interface BrowserConfig {
  origin: string;
  token: string;
  runId: string;
  chatA: string;
  chatB: string;
  campaign: Campaign;
}

export interface BrowserObservation {
  kind: 'garcon-bombadil-v1';
  stage: number;
  documents: number;
  reloadBaseline: number;
  wsOpens: number;
  documentWsOpen: boolean;
  wsCloses: number[];
  apiErrors: string[];
  actionErrors: string[];
  complete: boolean;
  randomActions: number;
  scrollChanges: number;
  acceptedTurns: AcceptedTurn[];
}

export type AcceptedTurn = {
  chatId: string;
  turnId: string;
  clientMessageId: string;
};

declare global {
  interface Window { __bombadil?: BrowserObservation; }
}

export const observerKey = 'garcon-bombadil-observer';

export function bootstrap(config: BrowserConfig): void {
  if (typeof window === 'undefined' || window !== window.top || location.origin !== config.origin) return;
  const marker = 'garcon-bombadil-bootstrap';
  if (sessionStorage.getItem(marker) !== config.runId) {
    if (!localStorage.getItem('bearer-token') && !localStorage.getItem('garcon.logout-epoch')) {
      localStorage.setItem('bearer-token', JSON.stringify({ token: config.token, epoch: null }));
    }
    if (!localStorage.getItem('pref_local_settings')) {
      localStorage.setItem('pref_local_settings', JSON.stringify({ allowDirectChats: true, composerInputMode: 'source' }));
    }
    sessionStorage.setItem(marker, config.runId);
  }
  const saved = sessionStorage.getItem(observerKey);
  const observation: BrowserObservation = saved ? JSON.parse(saved) : {
    kind: 'garcon-bombadil-v1', stage: 0, documents: 0, reloadBaseline: 0, wsOpens: 0, documentWsOpen: false, wsCloses: [],
    apiErrors: [], actionErrors: [], complete: false, randomActions: 0, scrollChanges: 0, acceptedTurns: [],
  };
  observation.documents++;
  observation.documentWsOpen = false;
  window.__bombadil = observation;
  const persist = () => sessionStorage.setItem(observerKey, JSON.stringify(observation));
  persist();
  const originalFetch = window.fetch;
  window.fetch = new Proxy(originalFetch, { async apply(target, receiver, args) {
    const response: Response = await Reflect.apply(target, receiver, args);
    const url = new URL(response.url, location.href);
    if (url.origin === config.origin && url.pathname.startsWith('/api/') && response.status >= 400) {
      if (observation.apiErrors.length < 20) observation.apiErrors.push(`${response.status} ${url.pathname}`);
      persist();
    }
    if (url.origin === config.origin && url.pathname === '/api/v1/chats/run' && response.ok) {
      try {
        const request: AgentRunCommandRequest = JSON.parse(args[1].body);
        const accepted: AgentTurnCommandResponse = await response.clone().json();
        if (typeof request.clientMessageId !== 'string' || typeof accepted.turnId !== 'string'
          || accepted.chatId !== request.chatId || accepted.clientRequestId !== request.clientRequestId
          || observation.acceptedTurns.length >= 8) throw new Error('Invalid turn acceptance');
        observation.acceptedTurns.push({ chatId: accepted.chatId, turnId: accepted.turnId, clientMessageId: request.clientMessageId });
      } catch {
        if (observation.apiErrors.length < 20) observation.apiErrors.push('Invalid turn acceptance');
      }
      persist();
    }
    return response;
  } });
  const OriginalWebSocket = window.WebSocket;
  let currentSocket: WebSocket | undefined;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const parsed = new URL(url, location.href);
      if (parsed.host !== location.host) return;
      // The SPA retires its previous socket before creating a replacement.
      currentSocket = this;
      observation.documentWsOpen = false;
      persist();
      this.addEventListener('open', () => {
        observation.wsOpens++;
        if (currentSocket === this) observation.documentWsOpen = true;
        persist();
      });
      this.addEventListener('close', event => {
        if (currentSocket === this) observation.documentWsOpen = false;
        if (observation.wsCloses.length < 20) observation.wsCloses.push(event.code);
        persist();
      });
    }
  };
}

export function visible(element: Element): element is HTMLElement {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
}

export function commandPanel(document: Document): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-conversation-panel-command-owner="true"]')).find(visible) ?? null;
}

export const controlNames = ['chatA', 'chatB', 'composer', 'send', 'queue', 'stop', 'edit', 'editor', 'save', 'menu', 'remove'] as const;
export type Control = typeof controlNames[number];

export function findControl(document: Document, config: BrowserConfig, control: Control): HTMLElement | null {
  const panel = commandPanel(document);
  switch (control) {
    case 'chatA':
    case 'chatB':
      return document.querySelector<HTMLElement>(`[data-sidebar-virtual-row="${config[control]}"] button`);
    case 'composer':
      return document.querySelector<HTMLElement>('textarea[placeholder="Reply..."]');
    case 'editor':
      return document.querySelector<HTMLElement>('#queued-input-draft');
    case 'save':
      return Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'))
        .find(button => button.textContent?.trim() === 'Save edit') ?? null;
    case 'remove':
      return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find(item => item.textContent?.trim() === 'Remove from queue') ?? null;
  }
  const selectors = {
    send: 'button[aria-label="Send message"]', queue: 'button[aria-label="Queue message"]',
    stop: 'button[aria-label="Stop"]', edit: '[data-queue-edit-id]', menu: '[data-queue-menu-id]',
  };
  const target = panel?.querySelector<HTMLElement>(selectors[control]);
  if (target) return target;
  if (control === 'send' || control === 'queue') return document.querySelector<HTMLElement>(selectors[control]);
  return null;
}

export function requireTarget(document: Document, element: HTMLElement | null): HTMLElement {
  if (!element || !visible(element) || element.matches(':disabled,[aria-disabled="true"]')) {
    throw new Error('Allowlisted control is unavailable');
  }
  const rect = element.getBoundingClientRect();
  const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
  if (!hit || !element.contains(hit)) throw new Error('Allowlisted control is covered or outside the viewport');
  return element;
}
