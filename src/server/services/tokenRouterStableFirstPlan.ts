/**
 * Stable-first candidate pooling: which sites lead, which ones are admitted only
 * as observation traffic, and the cadence of that observation.
 *
 * Extracted from `tokenRouter.ts` (3736 lines) as the first slice of its split.
 * This block was the most self-contained: it consumes candidates plus the site
 * runtime-health accessor and returns a plan, with no reach into the router's
 * caches or instance state. The round-robin memory it reads already lives in its
 * own module.
 */
import type { RouteChannelCandidate } from './tokenRouterTypes.js';
import { clampNumber, compareNullableTimeAsc } from './tokenRouterMath.js';
import {
  getSiteRuntimeHealthDetails,
  type SiteRuntimeHealthDetails,
} from './tokenRouterRuntimeHealthStore.js';
import {
  getStableFirstObservationProgressByKey,
  getStableFirstObservationSiteCooldownByKey,
  rememberStableFirstObservationProgressForKey,
  rememberStableFirstObservationSiteCooldown,
} from './tokenRouterStableFirstMemory.js';

const SITE_RECENT_SUCCESS_FALLBACK_RATE = 0.5;

// Tuning for buildSiteHistoricalHealthMetrics(): how much a site's historical
// record can penalise it, and how much of that record is considered relevant.
const SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER = 0.45;
const SITE_HISTORICAL_HEALTH_MAX_SAMPLE = 24;
const SITE_HISTORICAL_LATENCY_BASELINE_MS = 3_000;
const SITE_HISTORICAL_LATENCY_WINDOW_MS = 25_000;
const SITE_HISTORICAL_MAX_LATENCY_PENALTY = 0.45;

export type StableFirstSitePoolState = {
  siteId: number;
  leader: RouteChannelCandidate;
  effectiveSuccessRate: number;
  trusted: boolean;
  observationReason: string | null;
};

export type StableFirstPoolPlan = {
  primaryCandidates: RouteChannelCandidate[];
  observationCandidates: RouteChannelCandidate[];
  primarySiteIds: Set<number>;
  observationSiteIds: Set<number>;
  siteStateById: Map<number, StableFirstSitePoolState>;
};

const STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO = 0.92;
const STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE = 0.5;
const STABLE_FIRST_TRUSTED_HISTORICAL_CALLS = 8;
export const STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL = 24;
const STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS = 30 * 60 * 1000;

export function resolveStableFirstSuccessRate(
  details: SiteRuntimeHealthDetails,
  historicalSuccessRate: number | null | undefined,
): number {
  const fallbackRate = historicalSuccessRate ?? SITE_RECENT_SUCCESS_FALLBACK_RATE;
  return (
    (details.recentSuccessRate * details.recentConfidence)
    + (fallbackRate * (1 - details.recentConfidence))
  );
}



export function compareStableFirstCandidateOrder(left: RouteChannelCandidate, right: RouteChannelCandidate): number {
  const selectionOrder = compareNullableTimeAsc(
    left.channel.lastSelectedAt || left.channel.lastUsedAt,
    right.channel.lastSelectedAt || right.channel.lastUsedAt,
  );
  if (selectionOrder !== 0) return selectionOrder;

  const usedOrder = compareNullableTimeAsc(left.channel.lastUsedAt, right.channel.lastUsedAt);
  if (usedOrder !== 0) return usedOrder;

  return (left.channel.id ?? 0) - (right.channel.id ?? 0);
}

export type SiteHistoricalHealthMetrics = {
  multiplier: number;
  totalCalls: number;
  successRate: number | null;
  avgLatencyMs: number | null;
};

export function buildSiteHistoricalHealthMetrics(candidates: RouteChannelCandidate[]): Map<number, SiteHistoricalHealthMetrics> {
  const totals = new Map<number, {
    totalCalls: number;
    successCount: number;
    failCount: number;
    totalLatencyMs: number;
    latencySamples: number;
  }>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    if (!totals.has(siteId)) {
      totals.set(siteId, {
        totalCalls: 0,
        successCount: 0,
        failCount: 0,
        totalLatencyMs: 0,
        latencySamples: 0,
      });
    }
    const target = totals.get(siteId)!;
    const successCount = Math.max(0, candidate.channel.successCount ?? 0);
    const failCount = Math.max(0, candidate.channel.failCount ?? 0);
    target.successCount += successCount;
    target.failCount += failCount;
    target.totalCalls += successCount + failCount;
    if (successCount > 0) {
      target.totalLatencyMs += Math.max(0, candidate.channel.totalLatencyMs ?? 0);
      target.latencySamples += successCount;
    }
  }

  const metrics = new Map<number, SiteHistoricalHealthMetrics>();
  for (const [siteId, total] of totals.entries()) {
    if (total.totalCalls <= 0) {
      metrics.set(siteId, {
        multiplier: 1,
        totalCalls: 0,
        successRate: null,
        avgLatencyMs: null,
      });
      continue;
    }

    const sampleFactor = clampNumber(total.totalCalls / SITE_HISTORICAL_HEALTH_MAX_SAMPLE, 0, 1);
    const successRate = total.successCount / total.totalCalls;
    const successPenaltyFactor = 1 - ((1 - successRate) * 0.55 * sampleFactor);
    const avgLatencyMs = total.latencySamples > 0
      ? Math.round(total.totalLatencyMs / total.latencySamples)
      : null;
    const latencyPenaltyRatio = avgLatencyMs == null
      ? 0
      : clampNumber(
        (avgLatencyMs - SITE_HISTORICAL_LATENCY_BASELINE_MS) / SITE_HISTORICAL_LATENCY_WINDOW_MS,
        0,
        1,
      ) * sampleFactor;
    const latencyFactor = 1 - (latencyPenaltyRatio * SITE_HISTORICAL_MAX_LATENCY_PENALTY);
    metrics.set(siteId, {
      multiplier: clampNumber(
        successPenaltyFactor * latencyFactor,
        SITE_HISTORICAL_HEALTH_MIN_MULTIPLIER,
        1,
      ),
      totalCalls: total.totalCalls,
      successRate,
      avgLatencyMs,
    });
  }

  return metrics;
}

export function buildStableFirstPoolPlan(
  candidates: RouteChannelCandidate[],
  modelName: string | ((candidate: RouteChannelCandidate) => string),
  nowMs = Date.now(),
): StableFirstPoolPlan {
  if (candidates.length <= 0) {
    return {
      primaryCandidates: [],
      observationCandidates: [],
      primarySiteIds: new Set<number>(),
      observationSiteIds: new Set<number>(),
      siteStateById: new Map<number, StableFirstSitePoolState>(),
    };
  }

  const resolveModelName = typeof modelName === 'function'
    ? modelName
    : (() => modelName);
  const historicalBySiteId = buildSiteHistoricalHealthMetrics(candidates);
  const leaderBySiteId = new Map<number, RouteChannelCandidate>();
  const siteStateById = new Map<number, StableFirstSitePoolState>();

  for (const candidate of candidates) {
    const siteId = candidate.site.id;
    const currentLeader = leaderBySiteId.get(siteId);
    if (!currentLeader || compareStableFirstCandidateOrder(candidate, currentLeader) < 0) {
      leaderBySiteId.set(siteId, candidate);
    }
  }

  for (const [siteId, leader] of leaderBySiteId.entries()) {
    const healthDetails = getSiteRuntimeHealthDetails(siteId, resolveModelName(leader), nowMs);
    const historical = historicalBySiteId.get(siteId);
    const historicalTotalCalls = historical?.totalCalls ?? 0;
    const effectiveSuccessRate = resolveStableFirstSuccessRate(healthDetails, historical?.successRate);
    const trusted = (
      healthDetails.recentConfidence >= STABLE_FIRST_TRUSTED_RECENT_CONFIDENCE
      || historicalTotalCalls >= STABLE_FIRST_TRUSTED_HISTORICAL_CALLS
    );
    siteStateById.set(siteId, {
      siteId,
      leader,
      effectiveSuccessRate,
      trusted,
      observationReason: null,
    });
  }

  const allSiteStates = Array.from(siteStateById.values()).sort((left, right) => {
    const rateDiff = right.effectiveSuccessRate - left.effectiveSuccessRate;
    if (Math.abs(rateDiff) > 1e-9) return rateDiff > 0 ? 1 : -1;
    return compareStableFirstCandidateOrder(left.leader, right.leader);
  });
  const trustedSiteStates = allSiteStates.filter((state) => state.trusted);
  const leaderPool = trustedSiteStates.length > 0 ? trustedSiteStates : allSiteStates;

  const primarySiteIds = new Set<number>();
  const observationSiteIds = new Set<number>();
  const bestRate = leaderPool[0]?.effectiveSuccessRate ?? 0;
  const thresholdRate = bestRate > 0
    ? (bestRate * STABLE_FIRST_PRIMARY_SUCCESS_RATE_RATIO)
    : 0;

  for (const state of allSiteStates) {
    const inPrimary = leaderPool.length === 0
      ? true
      : (
        leaderPool.some((leaderState) => leaderState.siteId === state.siteId)
        && state.effectiveSuccessRate >= thresholdRate
      );
    if (inPrimary) {
      primarySiteIds.add(state.siteId);
      continue;
    }
    observationSiteIds.add(state.siteId);
    state.observationReason = state.trusted
      ? '观察池：近期成功率暂时落后，仅灰度真实流量会命中'
      : '观察池：近期样本不足，仅灰度真实流量会命中';
  }

  if (primarySiteIds.size <= 0 && allSiteStates.length > 0) {
    primarySiteIds.add(allSiteStates[0].siteId);
    observationSiteIds.delete(allSiteStates[0].siteId);
  }

  return {
    primaryCandidates: candidates.filter((candidate) => primarySiteIds.has(candidate.site.id)),
    observationCandidates: candidates.filter((candidate) => observationSiteIds.has(candidate.site.id)),
    primarySiteIds,
    observationSiteIds,
    siteStateById,
  };
}

export function shouldUseStableFirstObservationCandidate(
  rotationKey: string,
  observationCandidates: RouteChannelCandidate[],
  nowMs = Date.now(),
): boolean {
  if (!rotationKey || observationCandidates.length <= 0) return false;
  const state = getStableFirstObservationProgressByKey().get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if ((state.requestCount + 1) < STABLE_FIRST_OBSERVATION_REQUEST_INTERVAL) {
    return false;
  }
  return observationCandidates.some((candidate) => {
    const observedAtMs = getStableFirstObservationSiteCooldownByKey().get(`${rotationKey}:${candidate.site.id}`) ?? null;
    return observedAtMs == null || (nowMs - observedAtMs) >= STABLE_FIRST_OBSERVATION_SITE_COOLDOWN_MS;
  });
}

export function updateStableFirstObservationProgress(
  rotationKey: string,
  input: {
    usedObservation: boolean;
    selectedSiteId?: number | null;
    nowMs?: number;
  },
): void {
  if (!rotationKey) return;
  const nowMs = input.nowMs ?? Date.now();
  const previous = getStableFirstObservationProgressByKey().get(rotationKey) ?? {
    requestCount: 0,
    lastObservationAtMs: null,
  };
  if (input.usedObservation) {
    rememberStableFirstObservationProgressForKey(rotationKey, {
      requestCount: 0,
      lastObservationAtMs: nowMs,
    });
    if (typeof input.selectedSiteId === 'number' && input.selectedSiteId > 0) {
      rememberStableFirstObservationSiteCooldown(rotationKey, input.selectedSiteId, nowMs);
    }
    return;
  }
  rememberStableFirstObservationProgressForKey(rotationKey, {
    requestCount: Math.max(0, previous.requestCount) + 1,
    lastObservationAtMs: previous.lastObservationAtMs,
  });
}
