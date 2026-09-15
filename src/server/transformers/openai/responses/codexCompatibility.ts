import { asTrimmedString } from '../../../shared/trimString.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

export const CODEX_DEFAULT_INSTRUCTIONS = 'You are a helpful assistant.';

/**
 * Platforms where the upstream may reject non-Codex clients at nginx/app layer.
 * Must stay in sync with the same set in upstreamRequestBuilder.ts
 * (ensureCodexClientFingerprintHeaders): when we fake the Codex CLI header
 * signature there, the responses body must also carry Codex client fields
 * (e.g. top-level `instructions`), or the upstream's official-client check
 * rejects the request with "This account only allows Codex official clients".
 */
const CODEX_GATED_PLATFORMS = new Set([
  'new-api',
  'one-api',
  'sub2api',
  'openai',
]);

function extractTextValue(content: Record<string, unknown>): string {
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (typeof content.output_text === 'string') return content.output_text;
  if (typeof content.input_text === 'string') return content.input_text;
  return '';
}

function isTextOnlyContentRecord(content: Record<string, unknown>): boolean {
  const blockType = asTrimmedString(content.type).toLowerCase();
  if (blockType === 'input_text' || blockType === 'output_text' || blockType === 'text') {
    return true;
  }
  const keys = Object.keys(content);
  return keys.length > 0 && keys.every((key) => (
    key === 'type'
    || key === 'text'
    || key === 'content'
    || key === 'output_text'
    || key === 'input_text'
  ));
}

function splitExtractedSystemContent(content: unknown): {
  extractedTexts: string[];
  remainingContent?: unknown;
} {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    return trimmed ? { extractedTexts: [trimmed] } : { extractedTexts: [] };
  }

  if (Array.isArray(content)) {
    const extractedTexts: string[] = [];
    const remainingItems: unknown[] = [];

    for (const item of content) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed) extractedTexts.push(trimmed);
        else remainingItems.push(item);
        continue;
      }

      if (!isRecord(item)) {
        remainingItems.push(item);
        continue;
      }

      const textValue = extractTextValue(item).trim();
      if (textValue && isTextOnlyContentRecord(item)) {
        extractedTexts.push(textValue);
        continue;
      }

      remainingItems.push(item);
    }

    return {
      extractedTexts,
      ...(remainingItems.length > 0 ? { remainingContent: remainingItems } : {}),
    };
  }

  if (!isRecord(content)) return { extractedTexts: [] };

  const textValue = extractTextValue(content).trim();
  if (textValue && isTextOnlyContentRecord(content)) {
    return { extractedTexts: [textValue] };
  }

  return {
    extractedTexts: [],
    remainingContent: content,
  };
}

function extractSystemMessagesToInstructions(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(body.input) || body.input.length <= 0) return body;

  const extractedSystemTexts: string[] = [];
  const remainingInput: unknown[] = [];

  for (const item of body.input) {
    if (!isRecord(item)) {
      remainingInput.push(item);
      continue;
    }
    if (asTrimmedString(item.type).toLowerCase() !== 'message') {
      remainingInput.push(item);
      continue;
    }
    if (asTrimmedString(item.role).toLowerCase() !== 'system') {
      remainingInput.push(item);
      continue;
    }

    const { extractedTexts, remainingContent } = splitExtractedSystemContent(item.content);
    if (extractedTexts.length > 0) {
      extractedSystemTexts.push(extractedTexts.join('\n'));
      if (remainingContent !== undefined) {
        remainingInput.push({
          ...item,
          content: remainingContent,
        });
      }
      continue;
    }

    remainingInput.push(item);
  }

  if (extractedSystemTexts.length <= 0) return body;

  const extractedInstructions = extractedSystemTexts.join('\n\n');
  const existingInstructions = typeof body.instructions === 'string' ? body.instructions : '';
  const nextInstructions = existingInstructions.trim()
    ? `${extractedInstructions}\n\n${existingInstructions}`
    : extractedInstructions;

  return {
    ...body,
    input: remainingInput,
    instructions: nextInstructions,
  };
}

function ensureCodexResponsesInstructions(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex' && !CODEX_GATED_PLATFORMS.has(sitePlatform)) return body;
  if (typeof body.instructions === 'string' && body.instructions.trim()) return body;
  return {
    ...body,
    instructions: CODEX_DEFAULT_INSTRUCTIONS,
  };
}

function ensureCodexResponsesStoreFalse(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex') return body;
  return {
    ...body,
    store: false,
  };
}

function stripCodexUnsupportedResponsesFields(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  const next = { ...body };
  // stream_options is a chat-completions-only field: the Responses API has no
  // such parameter, and codex-shaped backends reject it as unknown_parameter.
  // Observed live: codex-gated new-api gateways 400 on
  // stream_options.include_usage when a downstream stream asked for usage
  // (the chat→responses conversion carries the field into this body). Drop it
  // for every Responses-shaped upstream.
  delete next.stream_options;
  if (sitePlatform !== 'codex') return next;
  delete next.max_output_tokens;
  delete next.max_completion_tokens;
  delete next.max_tokens;
  return next;
}

function applyCodexResponsesCompatibility(
  body: Record<string, unknown>,
  sitePlatform: string,
): Record<string, unknown> {
  if (sitePlatform !== 'codex' && !CODEX_GATED_PLATFORMS.has(sitePlatform)) return body;
  return extractSystemMessagesToInstructions(body);
}

export function normalizeCodexResponsesBodyForProxy(
  body: Record<string, unknown>,
  sitePlatform: string,
  options?: { codexCompat?: boolean },
): Record<string, unknown> {
  // A site whose protocol profile requires the Codex client (the sites
  // editor's Codex-client toggle) is validated by the upstream exactly like a
  // native codex platform, so it gets the identical body treatment.
  const platform = options?.codexCompat === true ? 'codex' : sitePlatform;
  if (platform === 'codex') {
    return ensureCodexResponsesStoreFalse(
      stripCodexUnsupportedResponsesFields(
        ensureCodexResponsesInstructions(
          applyCodexResponsesCompatibility(body, platform),
          platform,
        ),
        platform,
      ),
      platform,
    );
  }
  if (CODEX_GATED_PLATFORMS.has(platform)) {
    // For codex-gated platforms (sub2api/new-api/openai), apply only safe body
    // normalizations that real Codex CLI clients always send (top-level
    // `instructions`). The header fingerprint is already injected by
    // ensureCodexClientFingerprintHeaders; keeping the body consistent avoids
    // upstream "This account only allows Codex official clients" rejections.
    // stream_options is dropped here too: codex-shaped backends reject the
    // chat-only field as unknown_parameter even on gated relays.
    return stripCodexUnsupportedResponsesFields(
      ensureCodexResponsesInstructions(
        applyCodexResponsesCompatibility(body, platform),
        platform,
      ),
      platform,
    );
  }
  return body;
}
