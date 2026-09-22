export type OauthQuotaWindowSnapshot = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string;
};

/**
 * Generic quota entry for providers whose upstream does not publish the
 * 5h/7d window pair (per-model buckets, credit pools, monthly counters).
 * `kind` tells the UI how to render the numbers:
 * - `window`  — a rolling time window, the number is a percentage used
 * - `bucket`  — a per-model allowance, the number is the raw unit count
 * - `credits` — an absolute balance, the number is the raw unit count
 */
export type OauthQuotaEntrySnapshot = {
  key: string;
  label: string;
  kind: 'window' | 'bucket' | 'credits';
  used?: number | null;
  limit?: number | null;
  remaining?: number | null;
  remainingPercent?: number | null;
  unit?: string;
  resetAt?: string | null;
  unlimited?: boolean;
};

export type OauthQuotaSnapshot = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string;
  lastError?: string;
  providerMessage?: string;
  subscription?: {
    planType?: string;
    activeStart?: string;
    activeUntil?: string;
  };
  windows: {
    fiveHour: OauthQuotaWindowSnapshot;
    sevenDay: OauthQuotaWindowSnapshot;
  };
  /** Extra rows beyond the 5h/7d pair; omitted when not applicable. */
  entries?: OauthQuotaEntrySnapshot[];
  lastLimitResetAt?: string;
};
