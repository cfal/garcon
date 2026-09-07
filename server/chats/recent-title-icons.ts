import emojiRegex from 'emoji-regex';

export const RECENT_TITLE_ICON_LIMIT = 20;

export interface RecentTitleIconSource {
  getRecentIcons(): readonly string[];
}

export function extractTitleIcons(title: string): string[] {
  const icons: string[] = [];
  const seen = new Set<string>();

  for (const match of title.matchAll(emojiRegex())) {
    const icon = match[0];
    if (seen.has(icon)) continue;
    seen.add(icon);
    icons.push(icon);
  }

  return icons;
}

export class RecentTitleIconStore implements RecentTitleIconSource {
  readonly #capacity: number;
  readonly #icons: string[] = [];

  constructor(capacity = RECENT_TITLE_ICON_LIMIT) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new TypeError('Recent title icon capacity must be a positive integer.');
    }
    this.#capacity = capacity;
  }

  recordTitle(title: string): void {
    for (const icon of extractTitleIcons(title)) {
      const previousIndex = this.#icons.indexOf(icon);
      if (previousIndex >= 0) this.#icons.splice(previousIndex, 1);
      this.#icons.push(icon);
    }

    const overflow = this.#icons.length - this.#capacity;
    if (overflow > 0) this.#icons.splice(0, overflow);
  }

  getRecentIcons(): readonly string[] {
    return [...this.#icons].reverse();
  }
}
