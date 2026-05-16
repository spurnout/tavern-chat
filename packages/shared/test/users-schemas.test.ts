import { describe, expect, it } from 'vitest';
import { socialLinkSchema } from '../src/schemas/users.js';

describe('socialLinkSchema', () => {
  it('accepts https URLs', () => {
    const result = socialLinkSchema.safeParse({
      label: 'Mastodon',
      url: 'https://hachyderm.io/@me',
    });
    expect(result.success).toBe(true);
  });

  it('accepts http URLs', () => {
    const result = socialLinkSchema.safeParse({
      label: 'Blog',
      url: 'http://example.com/blog',
    });
    expect(result.success).toBe(true);
  });

  it('accepts mailto: URLs', () => {
    const result = socialLinkSchema.safeParse({
      label: 'Email',
      url: 'mailto:me@example.com',
    });
    expect(result.success).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'about:blank',
  ])('rejects dangerous URL scheme %s', (url) => {
    const result = socialLinkSchema.safeParse({ label: 'x', url });
    expect(result.success).toBe(false);
  });

  it('rejects non-URL strings', () => {
    const result = socialLinkSchema.safeParse({
      label: 'broken',
      url: 'not a url',
    });
    expect(result.success).toBe(false);
  });
});
