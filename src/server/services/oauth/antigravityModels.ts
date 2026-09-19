/**
 * Stable Antigravity model names aligned with CLIProxyAPI's runtime registry.
 *
 * Antigravity's fetchAvailableModels control-plane endpoint also returns
 * internal and experimental identifiers (for example chat_* and versioned
 * flash tiers). CLIProxyAPI deliberately does not register those identifiers
 * for normal routing; it sends these stable names to the runtime unchanged.
 * This list follows the models currently exposed by the deployed CPA image;
 * Claude aliases are intentionally absent so Claude traffic cannot be selected
 * through this platform.
 */
export const ANTIGRAVITY_STABLE_MODELS = [
  'gemini-3-flash',
  'gemini-3.1-flash-image',
  'gemini-3.1-pro-low',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash-high',
  'gemini-3.7-flash-high',
  'gemini-3.8-flash-high',
  'gemini-pro-agent',
  'gpt-oss-120b-medium',
] as const;

export function getAntigravityStableModels(): string[] {
  return [...ANTIGRAVITY_STABLE_MODELS];
}
