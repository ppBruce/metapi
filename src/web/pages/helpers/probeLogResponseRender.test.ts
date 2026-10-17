import { describe, expect, it } from 'vitest';
import { renderMarkdownWithLatexSafe, renderProbeResponseText } from './probeLogResponseRender.js';

// 回归：消毒器曾在 KaTeX 替换「之后」运行，白名单会剥掉 class="katex…" 并
// 展开 MathML，公式退化成「裸 TeX 源码 + 无样式字形文本」的乱码。
// 正确顺序：先消毒 Markdown 产物（占位符是纯文本），再注入 KaTeX。
describe('probe log response rendering (LaTeX + sanitize order)', () => {
  it('keeps KaTeX markup for inline and display formulas', () => {
    const html = renderMarkdownWithLatexSafe(
      '根据对数的乘积法则：$\\log_2(xy)=\\log_2 x+\\log_2 y$\n\n$$\\boxed{\\log_2(xy)=8}$$',
    );

    expect(html).toContain('class="katex"');
    expect(html).toContain('katex-mathml');
    expect(html).toContain('katex-display-block');
    expect(html).not.toContain('%%KATEX');
  });

  it('still strips dangerous markup carried by upstream responses', () => {
    const html = renderMarkdownWithLatexSafe(
      '<img src=x onerror=alert(1)><script>alert(2)</script>\n\n$\\sqrt{2}$',
    );

    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('onerror');
    expect(html).toContain('class="katex"');
  });

  it('renders LaTeX inside JSON-wrapped chat responses', () => {
    const raw = JSON.stringify({ choices: [{ message: { content: '所以 $\\log_2(xy)=8$。' } }] });
    const html = renderProbeResponseText(raw);

    expect(html).toContain('class="katex"');
    expect(html).not.toContain('%%KATEX');
  });
});
