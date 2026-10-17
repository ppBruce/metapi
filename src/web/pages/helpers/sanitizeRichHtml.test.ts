import { describe, expect, it } from 'vitest';
import { sanitizeRichHtml } from './siteAnnouncementPresentation.js';

const hasDomSanitizerSupport = typeof DOMParser === 'function' && typeof Node !== 'undefined';
const itWithDomSupport = hasDomSanitizerSupport ? it : it.skip;

// ProbeLogs renders upstream-controlled response text through this sanitizer
// before injecting it with dangerouslySetInnerHTML (stored-XSS surface).
describe('sanitizeRichHtml (untrusted upstream HTML)', () => {
  itWithDomSupport('drops script/style/iframe/object/embed and event handler attributes', () => {
    const dirty = [
      '<p>hello</p>',
      '<script>alert(1)</script>',
      '<style>body{display:none}</style>',
      '<iframe src="https://evil.example"></iframe>',
      '<object data="x"></object>',
      '<embed src="y">',
      '<img src="https://example.com/ok.png" onerror="alert(1)">',
      '<a href="javascript:alert(1)" onclick="alert(2)">click</a>',
    ].join('');

    const clean = sanitizeRichHtml(dirty);
    expect(clean.toLowerCase()).not.toContain('<script');
    expect(clean.toLowerCase()).not.toContain('<style');
    expect(clean.toLowerCase()).not.toContain('<iframe');
    expect(clean.toLowerCase()).not.toContain('<object');
    expect(clean.toLowerCase()).not.toContain('<embed');
    expect(clean.toLowerCase()).not.toContain('onerror');
    expect(clean.toLowerCase()).not.toContain('onclick');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('hello');
  });

  itWithDomSupport('escapes angle brackets carried in JSON previews', () => {
    const clean = sanitizeRichHtml('<pre>&lt;img src=x onerror=alert(1)&gt;</pre>');
    expect(clean.toLowerCase()).not.toContain('<img');
    expect(clean).toContain('&lt;img');
  });

  itWithDomSupport('keeps benign markdown output intact', () => {
    const clean = sanitizeRichHtml('<p>plain <strong>bold</strong> <code>x</code></p>');
    expect(clean).toContain('<strong>bold</strong>');
    expect(clean).toContain('<code>x</code>');
  });
});