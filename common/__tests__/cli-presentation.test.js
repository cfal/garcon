import { describe, expect, it } from 'bun:test';
import {
  coerceDurableCliPresentation,
  coerceDurableCliBodyDisclosure,
  isCliBodyDisclosure,
  isCliPresentation,
  normalizeCliHexColor,
} from '../cli-presentation.ts';

describe('CLI presentation', () => {
  it('normalizes CLI hex input to the strict durable form', () => {
    expect(normalizeCliHexColor('7C3AED')).toBe('#7c3aed');
    expect(normalizeCliHexColor('#C4B5FD')).toBe('#c4b5fd');
    expect(normalizeCliHexColor('fff')).toBeNull();
    expect(normalizeCliHexColor('#1234567')).toBeNull();
    expect(normalizeCliHexColor('red')).toBeNull();
  });

  it('validates and safely defaults durable body disclosure', () => {
    expect(isCliBodyDisclosure('collapsed')).toBe(true);
    expect(isCliBodyDisclosure('hidden')).toBe(false);
    expect(coerceDurableCliBodyDisclosure('collapsed')).toBe('collapsed');
    expect(coerceDurableCliBodyDisclosure(undefined)).toBe('expanded');
  });

  it('accepts only valid preset and discriminated custom presentations', () => {
    expect(isCliPresentation({ style: 'notice' })).toBe(true);
    expect(isCliPresentation({
      style: 'custom',
      customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
    })).toBe(true);
    expect(isCliPresentation({ style: 'custom' })).toBe(false);
    expect(isCliPresentation({
      style: 'custom',
      customStyle: { lightAccent: '#7C3AED', darkAccent: '#c4b5fd' },
    })).toBe(false);
    expect(isCliPresentation({ style: 'notice', customStyle: {} })).toBe(false);
  });

  it('preserves valid durable presentation and degrades malformed custom values', () => {
    const custom = {
      style: 'custom',
      customStyle: { lightAccent: '#7c3aed', darkAccent: '#c4b5fd' },
    };
    expect(coerceDurableCliPresentation(custom)).toEqual(custom);
    expect(coerceDurableCliPresentation('error')).toEqual({ style: 'error' });
    expect(coerceDurableCliPresentation({ style: 'custom', customStyle: {} }))
      .toEqual({ style: 'notice' });
  });
});
