import { describe, expect, it } from 'vitest';
import {
  detectContextOverflow,
  isContextOverflowError,
  parseContextWindowFromErrorText,
} from './upstreamContextSignals.js';

describe('upstreamContextSignals', () => {
  describe('isContextOverflowError', () => {
    it('detects OpenAI/OpenRouter style overflow errors on 400', () => {
      expect(isContextOverflowError(
        400,
        "This model's maximum context length is 128000 tokens. However, you requested 200000 tokens (100 in the messages, 199900 in the completion). Please reduce the length of the messages or completion.",
      )).toBe(true);
    });

    it('detects vLLM max_model_len errors', () => {
      expect(isContextOverflowError(
        400,
        'The model `qwen3` has max_model_len 32768, but the prompt length 41280 exceeds it',
      )).toBe(true);
    });

    it('detects CN relay wording', () => {
      expect(isContextOverflowError(400, '请求上下文超长：当前 200000 tokens 超出模型最大限制 131072')).toBe(true);
    });

    it('ignores non-overflow 400s', () => {
      expect(isContextOverflowError(400, 'Invalid request: unknown parameter temperaturex')).toBe(false);
    });

    it('ignores overflow wording on unrelated statuses', () => {
      expect(isContextOverflowError(500, 'maximum context length')).toBe(false);
      expect(isContextOverflowError(200, 'maximum context length')).toBe(false);
      expect(isContextOverflowError(401, 'invalid api key')).toBe(false);
    });
  });

  describe('parseContextWindowFromErrorText', () => {
    const cases: Array<[string, number | null]> = [
      [
        "This model's maximum context length is 128000 tokens. However, you requested 200000 tokens (100 in the messages, 199900 in the completion).",
        128000,
      ],
      ['max_model_len 32768', 32768],
      ['max_model_len=131072 exceeded', 131072],
      ['maximum model length: 131072', 131072],
      ['The input token count is 32825 but the model only supports up to 32768', 32768],
      ['context length exceeded: context window 200000', 200000],
      ['250000 tokens > 200000 maximum', 200000],
      ['请求上下文超长：当前 200000 tokens 超出模型最大限制 131072', 131072],
      ['prompt contains 120000 characters, maximum context length is 32768 tokens', 32768],
      ['no numbers here at all', null],
      ['some random error 123', null],
    ];

    it.each(cases)('parses %j -> %s', (text, expected) => {
      expect(parseContextWindowFromErrorText(text)).toBe(expected);
    });

    it('rejects implausible numbers', () => {
      expect(parseContextWindowFromErrorText('context length is 42')).toBeNull();
      expect(parseContextWindowFromErrorText('context length is 999999999999')).toBeNull();
    });
  });

  describe('detectContextOverflow', () => {
    it('combines classification and extraction', () => {
      expect(detectContextOverflow(400, 'maximum context length is 65536 tokens')).toEqual({
        overflow: true,
        limit: 65536,
      });
    });

    it('reports overflow without a limit when unparseable', () => {
      expect(detectContextOverflow(400, 'prompt is too long')).toEqual({ overflow: true, limit: null });
    });

    it('reports not overflow for unrelated errors', () => {
      expect(detectContextOverflow(429, 'rate limit exceeded')).toEqual({ overflow: false, limit: null });
    });
  });
});
