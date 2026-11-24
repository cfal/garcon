import type { BrowserObservation } from './browser.js';

export interface PanelSnapshot {
  chatId: string;
  rows: string[];
  text: string;
}

const chatAMarkers = ['bombadilalpha', 'bombadilclick', 'bombadilenter', 'bombadilheld',
  'bombadilqueued', 'bombadiledited', 'bombadilafterstop'];

export function validPanels(panels: PanelSnapshot[], chatA: string, chatB: string): boolean {
  return panels.every(panel => new Set(panel.rows).size === panel.rows.length
    && !panel.text.includes('Failed to render message') && !panel.text.includes('Failed to load messages')
    && (panel.chatId !== chatA || !panel.text.includes('bombadilbravo'))
    && (panel.chatId !== chatB || chatAMarkers.every(marker => !panel.text.includes(marker))));
}

export function uniqueQueueEntries(queues: string[][]): boolean {
  return queues.every(entries => new Set(entries).size === entries.length);
}

export function completedWorkflow(observation: BrowserObservation | undefined, ready: boolean): boolean {
  return observation?.complete === true && ready && observation.documentWsOpen
    && observation.scrollChanges > 0 && observation.documents > observation.reloadBaseline
    && observation.randomActions >= 30;
}
