/**
 * Rough token estimation for a downstream request body — used ONLY for
 * routing decisions (does this request fit a site's context window?), never
 * for billing. Calibration mirrors the estimator proven for context
 * pre-flight elsewhere: CJK/Hangul/Kana codepoints ≈ 1 token each; everything
 * else ≈ ceil(UTF-8 bytes / 4). Images are priced at a flat per-image cost
 * and their payloads (base64 data URLs) are never counted as text.
 *
 * Pure functions only — safe for hot paths and unit tests.
 */

/** Flat per-image token allowance for routing math. */
export const IMAGE_TOKEN_ALLOWANCE = 1600;

const CJK_DENSE_RE = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

const IMAGE_PART_TYPES = new Set(['image', 'image_url', 'input_image']);

/** Rough token estimate: CJK-dense codepoints ≈ 1 token; others ≈ utf8 bytes / 4. */
export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const value = String(text);
  if (!value) return 0;
  if (/^[\x00-\x7f]*$/.test(value)) {
    return Math.ceil(value.length / 4);
  }
  let dense = 0;
  let rest = '';
  for (const ch of value) {
    if (CJK_DENSE_RE.test(ch)) dense += 1;
    else rest += ch;
  }
  const restBytes = new TextEncoder().encode(rest).length;
  return dense + Math.ceil(restBytes / 4);
}

function isBase64DataUrl(value: string): boolean {
  return /^data:[^;,]{0,80};base64,/i.test(value);
}

type WalkState = { images: number };

function walkValue(value: unknown, state: WalkState): number {
  if (typeof value === 'string') {
    // Image payloads must never be counted as text.
    if (isBase64DataUrl(value)) {
      state.images += 1;
      return 0;
    }
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += walkValue(item, state);
    return total;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const partType = typeof record.type === 'string' ? record.type : '';
    if (IMAGE_PART_TYPES.has(partType)) {
      state.images += 1;
      return 0;
    }
    let total = 0;
    for (const [key, child] of Object.entries(record)) {
      if (key === 'image_url' || key === 'input_image') {
        state.images += 1;
        continue;
      }
      total += walkValue(child, state);
    }
    return total;
  }
  return 0;
}

export type RequestContextEstimate = {
  /** Estimated prompt-side tokens (messages/system/tools text + image allowance). */
  promptTokens: number;
  /** Requested output budget counted into the requirement. */
  outputBudgetTokens: number;
  /** promptTokens + outputBudgetTokens + safety margin. */
  requiredTokens: number;
};

/**
 * Resolve the output budget a request declares: max_tokens /
 * max_completion_tokens / max_output_tokens, else the configured default.
 */
export function resolveOutputBudgetTokens(
  body: unknown,
  defaultOutputTokens: number,
): number {
  const record = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens'] as const) {
    const raw = record[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (Number.isFinite(value) && value > 0 && value <= 10_000_000) {
      return Math.trunc(value);
    }
  }
  return Math.max(1, Math.trunc(defaultOutputTokens || 8192));
}

/**
 * Estimate the routing requirement for one downstream request body:
 * requiredTokens = prompt + output budget + margin (%).
 */
export function resolveRequestContextRequirement(
  body: unknown,
  options: { defaultOutputTokens: number; marginPct: number },
): RequestContextEstimate {
  const state: WalkState = { images: 0 };
  const textTokens = walkValue(body, state);
  const promptTokens = textTokens + state.images * IMAGE_TOKEN_ALLOWANCE;
  const outputBudgetTokens = resolveOutputBudgetTokens(body, options.defaultOutputTokens);
  const marginPct = Number.isFinite(options.marginPct) && options.marginPct >= 0 ? options.marginPct : 0;
  const base = promptTokens + outputBudgetTokens;
  // Integer math for the margin (base * (1 + pct/100) hits float rounding).
  const requiredTokens = base + Math.ceil((base * marginPct) / 100);
  return { promptTokens, outputBudgetTokens, requiredTokens };
}
