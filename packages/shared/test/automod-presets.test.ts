import { describe, expect, it } from 'vitest';
import { AUTOMOD_PRESETS, findAutomodPreset } from '../src/automod-presets.js';

describe('automod presets', () => {
  it('exposes presets with unique ids and at least one rule each', () => {
    const ids = new Set<string>();
    for (const p of AUTOMOD_PRESETS) {
      expect(p.id).toBeTruthy();
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      expect(p.rules.length).toBeGreaterThan(0);
      for (const r of p.rules) {
        expect(r.pattern.length).toBeGreaterThan(0);
        expect(['regex', 'wordlist', 'link_rate', 'message_rate']).toContain(r.kind);
        expect(['log_only', 'delete', 'hold', 'warn', 'timeout']).toContain(r.action);
      }
    }
  });

  it('resolves a known preset and returns undefined for an unknown one', () => {
    expect(findAutomodPreset('invite-link-spam')?.label).toBe('Invite-link spam');
    expect(findAutomodPreset('does-not-exist')).toBeUndefined();
  });

  it('the invite-link regex matches a discord invite and ignores plain text', () => {
    const preset = findAutomodPreset('invite-link-spam');
    const rule = preset?.rules[0];
    expect(rule).toBeDefined();
    const re = new RegExp(rule!.pattern, 'i');
    expect(re.test('join us at discord.gg/abc123')).toBe(true);
    expect(re.test('just a normal sentence')).toBe(false);
  });
});
