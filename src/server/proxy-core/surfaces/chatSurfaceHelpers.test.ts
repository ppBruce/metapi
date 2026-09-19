import { describe, expect, it } from 'vitest';
import { anthropicMessagesTransformer } from '../../transformers/anthropic/messages/index.js';
import {
  buildDownstreamStreamLinesFromGeminiNativeSse,
  buildOpenAiFinalFromGeminiNativePayload,
} from './chatSurfaceHelpers.js';

const requestedModel = 'gemini-3.8-flash-high';

function wrappedGeminiResponse(text: string) {
  return {
    response: {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: {
        promptTokenCount: 4,
        candidatesTokenCount: 3,
        totalTokenCount: 7,
      },
      modelVersion: 'gemini-3.6-flash-internal',
      responseId: 'ag-response-1',
    },
    traceId: 'trace-1',
  };
}

describe('Antigravity Gemini-native response bridge', () => {
  it('unwraps non-stream responses and preserves the requested public model alias', () => {
    const normalized = buildOpenAiFinalFromGeminiNativePayload(
      wrappedGeminiResponse('你好'),
      requestedModel,
    );

    expect(normalized).toMatchObject({
      id: 'ag-response-1',
      model: requestedModel,
      content: '你好',
      finishReason: 'stop',
    });

    const claude = anthropicMessagesTransformer.serializeFinalResponse(normalized, {
      promptTokens: 4,
      completionTokens: 3,
      totalTokens: 7,
    });
    expect(claude).toMatchObject({
      type: 'message',
      model: requestedModel,
      content: [{ type: 'text', text: '你好' }],
    });
  });

  it('converts wrapped Antigravity SSE to OpenAI chunks', () => {
    const raw = `data: ${JSON.stringify(wrappedGeminiResponse('你好'))}\n\n`;
    const result = buildDownstreamStreamLinesFromGeminiNativeSse(raw, requestedModel, 'openai');

    expect(result.hasSemanticOutput).toBe(true);
    expect(result.lines.at(-1)).toBe('data: [DONE]\n\n');
    expect(result.lines.join('')).toContain('"content":"你好"');
    expect(result.lines.join('')).toContain(`"model":"${requestedModel}"`);
  });

  it('converts wrapped Antigravity SSE to Anthropic events', () => {
    const raw = `data: ${JSON.stringify(wrappedGeminiResponse('你好'))}\n\n`;
    const result = buildDownstreamStreamLinesFromGeminiNativeSse(raw, requestedModel, 'claude');
    const stream = result.lines.join('');

    expect(result.hasSemanticOutput).toBe(true);
    expect(stream).toContain('event: message_start');
    expect(stream).toContain('event: content_block_delta');
    expect(stream).toContain('"text":"你好"');
    expect(stream).toContain('event: message_stop');
    expect(stream).not.toContain('data: [DONE]');
  });

  it('flags terminal streams with no content, reasoning, or tools', () => {
    const raw = `data: ${JSON.stringify({
      response: {
        candidates: [],
        usageMetadata: { totalTokenCount: 4 },
      },
    })}\n\n`;

    const result = buildDownstreamStreamLinesFromGeminiNativeSse(raw, requestedModel, 'openai');
    expect(result.hasSemanticOutput).toBe(false);
  });
});
