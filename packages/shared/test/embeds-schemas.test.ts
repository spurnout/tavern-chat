import { describe, expect, it } from 'vitest';
import {
  actionRowSchema,
  buttonComponentSchema,
  messageEmbedSchema,
} from '../src/schemas/embeds.js';

describe('embed + component schemas', () => {
  it('accepts a well-formed embed and defaults fields to []', () => {
    const parsed = messageEmbedSchema.parse({ title: 'Hi', description: 'there' });
    expect(parsed.fields).toEqual([]);
  });

  it('rejects an embed description over the limit', () => {
    const res = messageEmbedSchema.safeParse({ description: 'x'.repeat(5000) });
    expect(res.success).toBe(false);
  });

  it('requires a customId on non-link buttons and forbids a url', () => {
    expect(
      buttonComponentSchema.safeParse({ type: 'button', style: 'primary', label: 'Go' }).success,
    ).toBe(false); // missing customId
    expect(
      buttonComponentSchema.safeParse({
        type: 'button',
        style: 'primary',
        label: 'Go',
        customId: 'go',
      }).success,
    ).toBe(true);
    expect(
      buttonComponentSchema.safeParse({
        type: 'button',
        style: 'primary',
        label: 'Go',
        customId: 'go',
        url: 'https://example.com',
      }).success,
    ).toBe(false); // url only allowed on link buttons
  });

  it('requires a url on link buttons and forbids a customId', () => {
    expect(
      buttonComponentSchema.safeParse({
        type: 'button',
        style: 'link',
        label: 'Open',
        url: 'https://example.com',
      }).success,
    ).toBe(true);
    expect(
      buttonComponentSchema.safeParse({ type: 'button', style: 'link', label: 'Open' }).success,
    ).toBe(false); // missing url
  });

  it('accepts an action row mixing a button and a select', () => {
    const res = actionRowSchema.safeParse({
      components: [
        { type: 'button', style: 'secondary', label: 'A', customId: 'a' },
        {
          type: 'select',
          customId: 's',
          options: [{ label: 'One', value: '1' }],
        },
      ],
    });
    expect(res.success).toBe(true);
  });
});
