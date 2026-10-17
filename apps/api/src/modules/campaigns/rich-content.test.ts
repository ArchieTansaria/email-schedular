import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from './rich-content.js';

describe('email HTML sanitization', () => {
  it('preserves supported formatting while stripping scripts, handlers and unsafe URLs', () => {
    const html = sanitizeEmailHtml(
      '<p style="text-align:center;color:red" onclick="alert(1)"><strong>Bold</strong> <em>Italic</em> <u>Underlined</u></p><ul><li>Item</li></ul><blockquote>Quote</blockquote><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">Bad link</a>',
    );
    expect(html).toContain('<strong>Bold</strong>');
    expect(html).toContain('<u>Underlined</u>');
    expect(html).toContain('text-align:center');
    expect(html).not.toMatch(/script|onclick|onerror|<img|javascript:|color:red/);
    expect(html).toContain('<ul><li>Item</li></ul>');
  });

  it('falls back to plain text for empty formatted content', () => {
    expect(sanitizeEmailHtml('<p><br></p>')).toBeUndefined();
  });
});
