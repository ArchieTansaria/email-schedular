import sanitizeHtml from 'sanitize-html';

export function sanitizeEmailHtml(html: string): string | undefined {
  const clean = sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'h2',
      'h3',
      'a',
      'code',
      'pre',
      'hr',
    ],
    allowedAttributes: {
      a: ['href', 'title'],
      p: ['style'],
      h2: ['style'],
      h3: ['style'],
      ol: ['start'],
    },
    allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/] } },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
  });
  return sanitizeHtml(clean, { allowedTags: [], allowedAttributes: {} }).trim() ? clean : undefined;
}
