import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../api.js';
import { useToast } from '../../components/Toast.js';
import { tr } from '../../i18n.js';
import { buildUpdateReminder } from '../helpers/updateCenterPresentation.js';

type UpdateVersionCandidate = {
  normalizedVersion?: string;
  displayVersion?: string;
  tagName?: string;
  digest?: string | null;
  publishedAt?: string | null;
} | null;

type UpdateCenterStatus = {
  currentVersion?: string;
  githubRelease?: UpdateVersionCandidate;
  dockerHubTag?: UpdateVersionCandidate;
  dockerHubRecentTags?: Array<NonNullable<UpdateVersionCandidate>> | null;
  runtime?: {
    lastCheckedAt?: string | null;
    lastCheckError?: string | null;
    lastResolvedDisplayVersion?: string | null;
  } | null;
};

type OtaStatusPayload = {
  supported?: boolean;
  supportedReason?: string;
  mode?: string;
  host?: {
    writableAppRoot?: boolean;
    graphicalSession?: boolean;
    pkexecAvailable?: boolean;
    supervised?: boolean;
    tier?: string;
  } | null;
  state?: {
    phase?: string;
    message?: string;
    version?: string;
    progressPct?: number;
    error?: string;
    command?: string;
  } | null;
  applied?: {
    status?: string;
    version?: string;
    fromVersion?: string;
  } | null;
  rollbackAvailable?: boolean;
};

function formatCheckedAt(value?: string | null): string {
  if (!value) return tr('从未检查');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return tr('从未检查');
  return parsed.toLocaleString();
}

function renderCandidateVersion(candidate: UpdateVersionCandidate | null | undefined): string {
  if (!candidate) return '—';
  return candidate.displayVersion || candidate.normalizedVersion || candidate.tagName || '—';
}

export default function UpdateCenterSection() {
  const toast = useToast();
  const [status, setStatus] = useState<UpdateCenterStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [ota, setOta] = useState<OtaStatusPayload | null>(null);
  const [otaBusy, setOtaBusy] = useState(false);
  const otaPollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getUpdateCenterStatus() as UpdateCenterStatus;
      setStatus(next);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('获取更新中心状态失败'));
    }
    try {
      const otaNext = await api.getUpdateCenterOta() as OtaStatusPayload;
      setOta(otaNext);
    } catch {
      setOta(null);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCheck = useCallback(async () => {
    setChecking(true);
    try {
      const next = await api.checkUpdateCenter() as UpdateCenterStatus;
      setStatus(next);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('检查更新失败'));
    } finally {
      setChecking(false);
    }
  }, [toast]);

  useEffect(() => () => {
    if (otaPollTimer.current) clearInterval(otaPollTimer.current);
  }, []);

  const refreshOta = useCallback(async () => {
    try {
      const otaNext = await api.getUpdateCenterOta() as OtaStatusPayload;
      setOta(otaNext);
      const phase = otaNext?.state?.phase;
      if (phase !== 'downloading' && phase !== 'verifying' && phase !== 'applying' && phase !== 'restarting') {
        if (otaPollTimer.current) {
          clearInterval(otaPollTimer.current);
          otaPollTimer.current = null;
        }
        setOtaBusy(false);
      }
      return otaNext;
    } catch {
      return null;
    }
  }, []);

  const startOtaPolling = useCallback(() => {
    if (otaPollTimer.current) return;
    otaPollTimer.current = setInterval(() => {
      void refreshOta();
    }, 2000);
  }, [refreshOta]);

  const handleOtaApply = useCallback(async (version: string) => {
    setOtaBusy(true);
    try {
      await api.applyUpdateCenterOta(version);
      toast.success(`已开始在线更新到 v${version}`);
      startOtaPolling();
      await refreshOta();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('在线更新启动失败'));
      setOtaBusy(false);
    }
  }, [refreshOta, startOtaPolling, toast]);

  const handleOtaRollback = useCallback(async () => {
    setOtaBusy(true);
    try {
      await api.rollbackUpdateCenterOta();
      toast.success(tr('已发起回滚'));
      startOtaPolling();
      await refreshOta();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast.error(errorMessage || tr('回滚失败'));
      setOtaBusy(false);
    }
  }, [refreshOta, startOtaPolling, toast]);

  const otaTargetVersion = String(
    status?.githubRelease?.normalizedVersion || status?.dockerHubTag?.normalizedVersion || '',
  ).trim();

  const reminder = buildUpdateReminder({
    currentVersion: status?.currentVersion,
    helper: null,
    githubRelease: status?.githubRelease,
    dockerHubTag: status?.dockerHubTag,
  });

  const rows: Array<{ label: string; value: string }> = [
    { label: tr('当前版本'), value: status?.currentVersion || '—' },
    { label: 'GitHub Releases', value: renderCandidateVersion(status?.githubRelease) },
    { label: 'Docker Hub', value: renderCandidateVersion(status?.dockerHubTag) },
    { label: tr('上次检查'), value: formatCheckedAt(status?.runtime?.lastCheckedAt) },
  ];

  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>{tr('更新中心')}</div>
        <button
          className="btn btn-primary btn-sm"
          disabled={checking}
          onClick={() => void handleCheck()}
        >
          {checking ? tr('检查中...') : tr('检查更新')}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        <span className={reminder.badgeClassName}>{reminder.label}</span>
      </div>
      {reminder.detail && (
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          {reminder.detail}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {rows.map((row) => (
          <div
            key={row.label}
            style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}
          >
            <span style={{ color: 'var(--color-text-muted)' }}>{row.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{row.value}</span>
          </div>
        ))}
      </div>

      {ota?.supported && reminder.highlight && otaTargetVersion && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={otaBusy}
            onClick={() => void handleOtaApply(otaTargetVersion)}
          >
            {otaBusy ? tr('在线更新中...') : `在线更新到 v${otaTargetVersion}`}
          </button>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
            热替换方式更新（OTA），失败可回滚
          </span>
        </div>
      )}
      {ota?.supported && ota.mode === 'host' && ota.host && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--color-text-muted)' }}>
          {ota.host.tier === 'direct'
            ? '宿主机模式：应用目录可写，更新零提权'
            : ota.host.tier === 'pkexec'
              ? '宿主机模式：需要提权时将弹出系统授权窗（polkit）'
              : '宿主机模式：无图形会话，需要提权时给出终端命令'}
        </div>
      )}
      {ota?.supported && ota.state && ota.state.phase && ota.state.phase !== 'idle' && (
        <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6, color: ota.state.phase === 'failed' ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
          {ota.state.message || ota.state.phase}
          {typeof ota.state.progressPct === 'number' && ota.state.progressPct > 0 ? `（${ota.state.progressPct}%）` : ''}
          {ota.state.error ? `：${ota.state.error}` : ''}
          {ota.state.command && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 4, wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
              {ota.state.command}
            </div>
          )}
        </div>
      )}
      {ota?.applied && (
        <div style={{ fontSize: 12, marginTop: 8, color: 'var(--color-text-muted)' }}>
          {`在线更新记录：v${ota.applied.fromVersion} → v${ota.applied.version}（${ota.applied.status}）`}
        </div>
      )}
      {ota?.rollbackAvailable && (
        <div style={{ marginTop: 10 }}>
          <button className="btn btn-ghost btn-sm" disabled={otaBusy} onClick={() => void handleOtaRollback()}>
            {tr('回滚到更新前版本')}
          </button>
        </div>
      )}

      {status?.runtime?.lastCheckError && (
        <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 10 }}>
          {tr('上次检查出错')}: {status.runtime.lastCheckError}
        </div>
      )}
    </div>
  );
}
