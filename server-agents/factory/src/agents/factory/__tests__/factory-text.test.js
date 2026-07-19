import { describe, expect, it } from 'bun:test';

import {
  convertFactoryAssistantText,
  isFactorySystemReminderText,
  visibleFactoryAssistantText,
} from '../factory-text.js';

describe('factory text normalization', () => {
  it('keeps only visible assistant text after Droid hidden thinking', () => {
    expect(visibleFactoryAssistantText('hidden reasoning</think>visible reply')).toBe('visible reply');
    expect(visibleFactoryAssistantText('</think>visible reply')).toBe('visible reply');
    expect(visibleFactoryAssistantText('visible reply')).toBe('visible reply');
  });

  it('drops hidden-only assistant text', () => {
    expect(convertFactoryAssistantText('2026-03-29T00:00:00.000Z', 'hidden only</think>')).toEqual([]);
  });

  it('identifies Factory system reminders', () => {
    expect(isFactorySystemReminderText('<system-reminder>internal</system-reminder>')).toBe(true);
    expect(isFactorySystemReminderText('<system-reminder source="droid">internal</system-reminder>')).toBe(true);
    expect(isFactorySystemReminderText('real user text')).toBe(false);
  });
});
