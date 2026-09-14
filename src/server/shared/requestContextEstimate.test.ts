import { describe, expect, it } from 'vitest';
import {
  IMAGE_TOKEN_ALLOWANCE,
  estimateTextTokens,
  resolveOutputBudgetTokens,
  resolveRequestContextRequirement,
} from './requestContextEstimate.js';

describe('estimateTextTokens', () => {
  it('estimates ascii by utf8 bytes / 4 (ceil)', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('a')).toBe(1);
    expect(estimateTextTokens('abcdefgh')).toBe(2);
    expect(estimateTextTokens('abcde')).toBe(2);
  });

  it('counts CJK as ~1 token per char', () => {
    expect(estimateTextTokens('你好世界')).toBe(4);
    expect(estimateTextTokens('你好hello')).toBe(4);
  });

  it('counts non-ascii non-CJK by utf8 bytes / 4', () => {
    expect(estimateTextTokens('привет')).toBe(3);
  });
});

describe('resolveOutputBudgetTokens', () => {
  it('reads max_tokens variants', () => {
    expect(resolveOutputBudgetTokens({ max_tokens: 32000 }, 8192)).toBe(32000);
    expect(resolveOutputBudgetTokens({ max_completion_tokens: 16000 }, 8192)).toBe(16000);
    expect(resolveOutputBudgetTokens({ max_output_tokens: '8000' }, 8192)).toBe(8000);
  });

  it('falls back to the default when absent or invalid', () => {
    expect(resolveOutputBudgetTokens({}, 8192)).toBe(8192);
    expect(resolveOutputBudgetTokens({ max_tokens: 0 }, 8192)).toBe(8192);
    expect(resolveOutputBudgetTokens({ max_tokens: 'abc' }, 8192)).toBe(8192);
    expect(resolveOutputBudgetTokens(null, 8192)).toBe(8192);
  });
});

describe('resolveRequestContextRequirement', () => {
  it('combines prompt, output budget and margin', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: '你好' },
      ],
      max_tokens: 1000,
    };
    const result = resolveRequestContextRequirement(body, { defaultOutputTokens: 8192, marginPct: 10 });
    // 'system'(2) + 'You are helpful.'(4) + 'user'(1) + '你好'(2) = 9; base = 1009; margin +101
    expect(result.promptTokens).toBe(9);
    expect(result.outputBudgetTokens).toBe(1000);
    expect(result.requiredTokens).toBe(1110);
  });

  it('does not count base64 image payloads as text, charges the flat image allowance', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'hi' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(100000) } },
          ],
        },
      ],
      max_tokens: 100,
    };
    const result = resolveRequestContextRequirement(body, { defaultOutputTokens: 8192, marginPct: 0 });
    // 'user'(1) + 'text'(1) + 'hi'(1) + image allowance = 1603
    expect(result.promptTokens).toBe(3 + IMAGE_TOKEN_ALLOWANCE);
    expect(result.requiredTokens).toBe(3 + IMAGE_TOKEN_ALLOWANCE + 100);
  });

  it('applies the default output budget when the request declares none', () => {
    const result = resolveRequestContextRequirement(
      { messages: [{ role: 'user', content: 'abcd' }] },
      { defaultOutputTokens: 4096, marginPct: 0 },
    );
    expect(result.outputBudgetTokens).toBe(4096);
    expect(result.requiredTokens).toBe(result.promptTokens + 4096);
  });
});
