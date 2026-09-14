/**
 * Upstream context-window signal parsing.
 *
 * Detects "context overflow" style upstream errors and extracts the real
 * context window the provider reports. The expression family follows the
 * runtime error-learning approach proven for context window discovery:
 * vLLM (`max_model_len`), OpenAI/OpenRouter ("maximum context length is N"),
 * Gemini ("supports only up to N"), LM Studio, plus common CN relay wordings.
 *
 * Deliberately conservative: extraction only accepts plausible window sizes
 * (1024..10,000,000) and prefers provider-anchored numbers over loose ones.
 * Pure functions only — safe for hot paths and unit tests.
 */

const MIN_PLAUSIBLE_WINDOW = 1024;
const MAX_PLAUSIBLE_WINDOW = 10_000_000;

/** HTTP statuses on which a context-overflow classification is plausible. */
const OVERFLOW_STATUSES = new Set([400, 413, 422]);

const STRONG_OVERFLOW_SIGNALS: RegExp[] = [
  /context_length_exceeded/i,
  /maximum\s+context\s+length/i,
  /context\s+(?:length|window)\s+(?:exceeded|too\s+large)/i,
  /max(?:imum)?[_ ]model[_ ]len/i,
  /reduce\s+the\s+length/i,
  /prompt\s+(?:is\s+)?too\s+long/i,
  /input\s+(?:is\s+)?too\s+long/i,
  /too\s+many\s+tokens/i,
  /token\s+limit\s+(?:exceeded|reached)/i,
  /exceed(?:s|ed)?\s+(?:the\s+)?(?:model'?s\s+)?(?:maximum\s+)?(?:context|token)/i,
  /上下文[^。]{0,16}(?:超长|过长|超出|超过)/,
  /(?:超出|超过)[^。]{0,16}(?:上下文|最大.{0,4}长度|长度限制)/,
];

/**
 * Whether an upstream error should be treated as "context window exceeded".
 * Status-gated: only 400/413/422 responses carry this class of error.
 */
export function isContextOverflowError(status: number, errorText: string | null | undefined): boolean {
  if (!OVERFLOW_STATUSES.has(Math.trunc(Number(status) || 0))) return false;
  const text = String(errorText || '');
  if (!text.trim()) return false;
  return STRONG_OVERFLOW_SIGNALS.some((pattern) => pattern.test(text));
}

/**
 * Ordered extraction patterns for the real context window inside an error
 * message. Provider-anchored forms first; loose numeric forms last. The first
 * plausible match wins.
 */
const WINDOW_EXTRACTION_PATTERNS: RegExp[] = [
  // vLLM / engines: max_model_len 32768, max_model_len: 131072, max_model_len=32768
  /max_model_len\D{0,24}?(\d{4,})/i,
  // vLLM alt wording
  /maximum\s+model\s+length\D{0,24}?(\d{4,})/i,
  // OpenAI / OpenRouter / DashScope: "maximum context length is 128000 tokens"
  /maximum\s+context\s+length\s*(?:is\s*)?[:=(]?\s*(\d{4,})/i,
  // context length is 32768 / context window: 200000 / context size of N
  /context\s*(?:length|window|size)\s*(?:is|of|:)?\s*(\d{4,})/i,
  // generic "limit/max ... 131072" (after the anchored forms above)
  /(?:max(?:imum)?|limit)\s*(?:context\s*)?(?:length|size|window)?\s*(?:is|of|:)?\s*(\d{4,})/i,
  // Gemini: "the model only supports up to 32768"
  /supports?\s+(?:only\s+)?up\s+to\s+(\d{4,})/i,
  // "250000 tokens > 200000 maximum" -> capture the bound after '>'
  />\s*(\d{4,})\s*(?:max|limit|token)/i,
  // "200000 maximum"
  /(\d{4,})\s*max(?:imum)?\b/i,
  // "131072 tokens" style tail (weakest)
  /(\d{4,})\s*(?:token)?\s*(?:context|limit)/i,
  // CN relay wordings: 最大限制 131072 / 上限 200000 / 超出 131072
  /(?:最大|上限|限制)\D{0,16}?(\d{4,})/,
  /(?:超出|超过)\D{0,16}?(\d{4,})/,
];

function isPlausibleWindow(value: number): boolean {
  return Number.isFinite(value) && value >= MIN_PLAUSIBLE_WINDOW && value <= MAX_PLAUSIBLE_WINDOW;
}

/**
 * Extract the context window reported inside an upstream error message.
 * Returns null when no plausible number is present (caller must NOT guess).
 */
export function parseContextWindowFromErrorText(errorText: string | null | undefined): number | null {
  const text = String(errorText || '');
  if (!text.trim()) return null;
  for (const pattern of WINDOW_EXTRACTION_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? '', 10);
    if (isPlausibleWindow(value)) {
      return value;
    }
  }
  return null;
}

/**
 * Combined helper for the runtime learning path: classify + extract in one
 * call. `limit` is null when the provider did not report a number.
 */
export function detectContextOverflow(
  status: number,
  errorText: string | null | undefined,
): { overflow: boolean; limit: number | null } {
  if (!isContextOverflowError(status, errorText)) {
    return { overflow: false, limit: null };
  }
  return { overflow: true, limit: parseContextWindowFromErrorText(errorText) };
}
