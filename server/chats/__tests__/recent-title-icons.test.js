import { describe, expect, it } from 'bun:test';
import {
  extractTitleIcons,
  RecentTitleIconStore,
} from '../recent-title-icons.js';

describe('extractTitleIcons', () => {
  it('extracts every distinct emoji sequence from the complete title', () => {
    expect(extractTitleIcons('Planning 🧑🏽‍💻 releases 🇨🇦 with keycaps 1️⃣ and 🧑🏽‍💻')).toEqual([
      '🧑🏽‍💻',
      '🇨🇦',
      '1️⃣',
    ]);
  });

  it('returns an empty list for titles without emojis', () => {
    expect(extractTitleIcons('Release planning')).toEqual([]);
  });
});

describe('RecentTitleIconStore', () => {
  it('keeps distinct icons in most-recently-used order', () => {
    const store = new RecentTitleIconStore(4);

    store.recordTitle('First 🧪 and 📦');
    store.recordTitle('Reuse 🧪 with 🔐');

    expect(store.getRecentIcons()).toEqual(['🔐', '🧪', '📦']);
  });

  it('evicts the least recently used icon at capacity', () => {
    const store = new RecentTitleIconStore(3);

    store.recordTitle('One 1️⃣ two 2️⃣ three 3️⃣');
    store.recordTitle('Touch 1️⃣ and add 4️⃣');

    expect(store.getRecentIcons()).toEqual(['4️⃣', '1️⃣', '3️⃣']);
  });

  it('does not expose mutable internal state', () => {
    const store = new RecentTitleIconStore();
    store.recordTitle('Testing 🧪');

    const snapshot = store.getRecentIcons();
    snapshot.pop();

    expect(store.getRecentIcons()).toEqual(['🧪']);
  });

  it('starts empty after construction', () => {
    const first = new RecentTitleIconStore();
    first.recordTitle('Testing 🧪');

    expect(new RecentTitleIconStore().getRecentIcons()).toEqual([]);
  });

  it('rejects invalid capacities', () => {
    expect(() => new RecentTitleIconStore(0)).toThrow(
      'Recent title icon capacity must be a positive integer.',
    );
    expect(() => new RecentTitleIconStore(1.5)).toThrow(
      'Recent title icon capacity must be a positive integer.',
    );
  });
});
