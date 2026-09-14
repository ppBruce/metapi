/**
 * 更新中心「在线更新」（OTA，dist 热替换）。
 *
 * 机制：从 GitHub Release 下载应用包（dist + drizzle + package.json + 清单），
 * 校验 sha256 与依赖 / Node 兼容性后，把当前应用文件整体搬到备份目录、把新文件
 * 换入原地，最后退出进程、由容器重启策略（restart: unless-stopped）拉起新版本；
 * 容器启动命令本来就会先跑迁移（`node dist/server/db/migrate.js`）。
 *
 * 设计边界（评估见仓库根目录的 OTA 评估文档）：
 * - Docker 部署默认开放（`/.dockerenv` 探测）；宿主机直跑用 METAPI_OTA_HOST_MODE=1 启用。
 * - 依赖发生变更的版本由 depsSignature 拦下，引导走镜像更新（见 updateCenterOtaManifest）。
 * - 容器被重建时写入层丢失，会回到镜像基线版本——更新中心如实展示（applied.json 随层消失）。
 * - 备份保留在 <appRoot>/.ota/backup-*，支持一键回滚。
 * - 交换动作容忍 overlayfs 的跨层限制：镜像层目录无法被 rename（EXDEV），
 *   自动退化为复制 + 删除（见 movePath）。
 *
 * 宿主机模式（METAPI_OTA_HOST_MODE=1）的提权阶梯（"像桌面软件一样，需要提权时自己弹窗"）：
 * 1. 应用目录对运行用户可写 → 直接替换（零提权）；重启依赖 systemd 等守护（退出后自动拉起）；
 * 2. 不可写、但有图形会话（DISPLAY/WAYLAND_DISPLAY）且 pkexec 可用 → 应用自己调用 pkexec，
 *    由系统弹出 polkit 图形授权窗，随后以 root 执行生成的 ota-apply.sh（备份/替换/修复属主/写记录）；
 * 3. 不可写且无图形会话（真 headless）→ 物理上无窗可弹；生成 `sudo sh <脚本>` 命令交由管理员在终端执行。
 * 备注：宿主机 + root 属主场景的"自动回滚"暂不在支持范围（可用备份目录手动恢复，后续 P2）。
 *
 * 测试/演练环境变量（仅内部使用）：
 * - METAPI_OTA_APP_ROOT            指定应用根（默认 process.cwd()）
 * - METAPI_OTA_HOST_MODE=1         启用宿主机直跑模式
 * - METAPI_OTA_ALLOW_NON_DOCKER=1  演练用：让非 Docker 环境按 Docker 语义运行
 * - METAPI_OTA_SKIP_RESTART=1      演练用：应用后不退出进程
 * - METAPI_OTA_BUNDLE_DIR          演练用：从本地目录取包，跳过 GitHub
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fetch } from 'undici';

import { db, schema } from '../db/index.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import {
  checkOtaCompatibility,
  computeDepsSignature,
  parseOtaManifest,
  resolveCurrentNodeMajor,
  OTA_MANIFEST_FILENAME,
  type OtaManifest,
} from './updateCenterOtaManifest.js';

export const OTA_DIR_NAME = '.ota';
const GITHUB_API_BASE = 'https://api.github.com/repos/wyf9661/metapi';
const DOWNLOAD_TIMEOUT_MS = 300_000;
const JSON_TIMEOUT_MS = 15_000;
const MAX_BUNDLE_BYTES = 200 * 1024 * 1024;
const SWAP_ENTRIES = ['dist', 'drizzle', 'package.json'] as const;
const PKEXEC_TIMEOUT_MS = 5 * 60 * 1000;

export type OtaPhase = 'idle' | 'downloading' | 'verifying' | 'applying' | 'restarting' | 'manual-required' | 'failed';

export type OtaState = {
  phase: OtaPhase;
  message: string;
  version?: string;
  progressPct?: number;
  error?: string;
  /** manual-required 阶段：供管理员复制的终端命令 */
  command?: string;
  startedAt?: string;
  finishedAt?: string;
};

export type OtaAppliedInfo = {
  status: 'pending' | 'applied' | 'rolled-back';
  version: string;
  fromVersion: string;
  gitSha: string;
  appliedAt: string;
  verifiedAt?: string;
  rolledBackAt?: string;
  backupDir: string;
};

let otaState: OtaState = { phase: 'idle', message: '' };
let otaRunning = false;

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error || 'unknown error');
}

function setOtaState(patch: Partial<OtaState>): void {
  otaState = { ...otaState, ...patch };
}

export function getOtaState(): OtaState {
  return otaState;
}

export function isOtaRunning(): boolean {
  return otaRunning;
}

export function resolveAppRoot(): string {
  const override = String(process.env.METAPI_OTA_APP_ROOT || '').trim();
  return override || process.cwd();
}

function isDockerRuntime(): boolean {
  if (existsSync('/.dockerenv')) return true;
  return String(process.env.METAPI_OTA_ALLOW_NON_DOCKER || '') === '1';
}

export type OtaMode = 'docker' | 'host' | 'disabled';
export type OtaHostTier = 'direct' | 'pkexec' | 'manual';

export type OtaHostInfo = {
  writableAppRoot: boolean;
  graphicalSession: boolean;
  pkexecAvailable: boolean;
  supervised: boolean;
  tier: OtaHostTier;
};

export function resolveOtaMode(): OtaMode {
  if (isDockerRuntime()) return 'docker';
  if (String(process.env.METAPI_OTA_HOST_MODE || '') === '1') return 'host';
  return 'disabled';
}

export function getOtaSupport(): { supported: boolean; reason?: string } {
  const mode = resolveOtaMode();
  if (mode === 'disabled') {
    return { supported: false, reason: '在线更新仅支持 Docker 部署，或经 METAPI_OTA_HOST_MODE=1 启用的宿主机部署' };
  }
  const root = resolveAppRoot();
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'dist/server/index.js'))) {
    return { supported: false, reason: '应用目录结构不符合预期，无法在线更新' };
  }
  return { supported: true };
}

/** 探测应用根目录对当前进程是否可写（宿主机模式下决定提权路径）。 */
export function probeAppRootWritable(root = resolveAppRoot()): boolean {
  try {
    const probe = join(root, `.ota-write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function hasGraphicalSession(): boolean {
  return Boolean(
    String(process.env.DISPLAY || '').trim() || String(process.env.WAYLAND_DISPLAY || '').trim(),
  );
}

export function isPkexecAvailable(): boolean {
  return existsSync('/usr/bin/pkexec') || existsSync('/bin/pkexec') || existsSync('/usr/local/bin/pkexec');
}

/** systemd 服务（INVOCATION_ID）或直接被 PID 1 托管时，退出后可自动拉起。 */
export function isSupervisedRuntime(): boolean {
  if (String(process.env.INVOCATION_ID || '').trim()) return true;
  return typeof process.ppid === 'number' && process.ppid === 1;
}

export function decideHostApplyTier(input: {
  writableAppRoot: boolean;
  graphicalSession: boolean;
  pkexecAvailable: boolean;
}): OtaHostTier {
  if (input.writableAppRoot) return 'direct';
  if (input.graphicalSession && input.pkexecAvailable) return 'pkexec';
  return 'manual';
}

const HOST_INFO_TTL_MS = 15_000;
let hostInfoCache: { at: number; root: string; value: OtaHostInfo } | null = null;

export function collectOtaHostInfo(root = resolveAppRoot()): OtaHostInfo {
  const now = Date.now();
  if (hostInfoCache && hostInfoCache.root === root && now - hostInfoCache.at < HOST_INFO_TTL_MS) {
    return hostInfoCache.value;
  }
  const writableAppRoot = probeAppRootWritable(root);
  const graphicalSession = hasGraphicalSession();
  const pkexecAvailable = isPkexecAvailable();
  const value: OtaHostInfo = {
    writableAppRoot,
    graphicalSession,
    pkexecAvailable,
    supervised: isSupervisedRuntime(),
    tier: decideHostApplyTier({ writableAppRoot, graphicalSession, pkexecAvailable }),
  };
  hostInfoCache = { at: now, root, value };
  return value;
}

function otaDir(root: string): string {
  return join(root, OTA_DIR_NAME);
}

function appliedInfoPath(root: string): string {
  return join(otaDir(root), 'applied.json');
}

export function readAppliedInfo(root = resolveAppRoot()): OtaAppliedInfo | null {
  try {
    const raw = readFileSync(appliedInfoPath(root), 'utf8');
    const parsed = JSON.parse(raw) as OtaAppliedInfo;
    if (!parsed || typeof parsed !== 'object' || !parsed.version || !parsed.backupDir) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeAppliedInfo(root: string, info: OtaAppliedInfo): void {
  const dir = otaDir(root);
  mkdirSync(dir, { recursive: true });
  const target = appliedInfoPath(root);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(info, null, 2)}\n`);
  renameSync(tmp, target);
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readRunningPackageJson(root: string): { version: string; depsSignature: string } {
  const pkg = readJsonFile(join(root, 'package.json')) || {};
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  // 复用清单模块的签名函数，保证与发布侧算法一致
  const depsSignature = computeDepsSignature({
    dependencies: (pkg.dependencies as Record<string, string> | undefined) || null,
    optionalDependencies: (pkg.optionalDependencies as Record<string, string> | undefined) || null,
  });
  return { version, depsSignature };
}

async function fetchJsonWithTimeout(url: string, timeoutMs = JSON_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'metapi-update-center/1.0' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

type BundleLocation =
  | { mode: 'local'; dir: string; tarballPath: string; sha256Path: string }
  | { mode: 'remote'; tarballUrl: string; sha256Url: string };

async function resolveBundleLocation(version: string): Promise<BundleLocation> {
  const fileName = `metapi-${version}-app.tar.gz`;
  const localDir = String(process.env.METAPI_OTA_BUNDLE_DIR || '').trim();
  if (localDir) {
    return {
      mode: 'local',
      dir: localDir,
      tarballPath: join(localDir, fileName),
      sha256Path: join(localDir, `${fileName}.sha256`),
    };
  }

  const release = await fetchJsonWithTimeout(`${GITHUB_API_BASE}/releases/tags/v${version}`);
  const assets = Array.isArray((release as { assets?: unknown[] })?.assets)
    ? ((release as { assets: Array<{ name?: string; browser_download_url?: string }> }).assets)
    : [];
  const tarball = assets.find((asset) => asset?.name === fileName);
  const sha256 = assets.find((asset) => asset?.name === `${fileName}.sha256`);
  if (!tarball?.browser_download_url || !sha256?.browser_download_url) {
    throw new Error(`v${version} 的发布资产里没有在线更新包（metapi-${version}-app.tar.gz），请改用镜像更新`);
  }
  return { mode: 'remote', tarballUrl: tarball.browser_download_url, sha256Url: sha256.browser_download_url };
}

async function downloadBundle(location: BundleLocation, destPath: string): Promise<void> {
  if (location.mode === 'local') {
    writeFileSync(destPath, readFileSync(location.tarballPath));
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(location.tarballUrl, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length') || 0);
    const file = createWriteStream(destPath);
    let received = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > MAX_BUNDLE_BYTES) throw new Error('更新包超出大小上限');
      file.write(chunk);
      if (total > 0) setOtaState({ progressPct: Math.min(99, Math.round((received / total) * 100)) });
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readSha256Sidecar(location: BundleLocation): Promise<string> {
  if (location.mode === 'local') {
    return readFileSync(location.sha256Path, 'utf8');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JSON_TIMEOUT_MS);
  try {
    const response = await fetch(location.sha256Url, { signal: controller.signal });
    if (!response.ok) throw new Error(`校验文件下载失败：HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

export function verifyBundleSha256(tarballPath: string, sidecarText: string): string {
  const match = String(sidecarText || '').trim().match(/^([a-f0-9]{64})\b/i);
  if (!match) throw new Error('sha256 校验文件格式无效');
  const expected = match[1].toLowerCase();
  const actual = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  if (actual !== expected) {
    throw new Error('更新包 sha256 校验失败，已放弃本次更新');
  }
  return actual;
}

export function extractAndValidateBundle(input: {
  root: string;
  tarballPath: string;
  targetVersion: string;
  /** 暂存根目录（宿主机且应用目录不可写时用 /tmp 下的临时目录） */
  stagingRoot?: string;
}): { stagingDir: string; manifest: OtaManifest } {
  const dir = input.stagingRoot || otaDir(input.root);
  mkdirSync(dir, { recursive: true });
  const stagingDir = join(dir, `staging-${input.targetVersion}-${Date.now()}`);
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });
  execFileSync('tar', ['-xzf', input.tarballPath, '-C', stagingDir], { stdio: 'pipe' });

  const manifest = parseOtaManifest(readFileSync(join(stagingDir, OTA_MANIFEST_FILENAME), 'utf8'));
  if (!manifest) throw new Error('更新包清单缺失或格式无效');
  if (manifest.version !== input.targetVersion) {
    throw new Error(`更新包版本不一致（包 ${manifest.version} / 目标 ${input.targetVersion}）`);
  }
  if (!existsSync(join(stagingDir, 'dist/server/index.js'))) {
    throw new Error('更新包内容不完整（缺少 dist/server/index.js）');
  }

  const running = readRunningPackageJson(input.root);
  const compatibility = checkOtaCompatibility(manifest, {
    nodeMajor: resolveCurrentNodeMajor(),
    depsSignature: running.depsSignature,
  });
  if (!compatibility.ok) throw new Error(compatibility.reason);

  return { stagingDir, manifest };
}

/**
 * 移动文件/目录：优先 rename；遇到 EXDEV（跨设备/跨 overlay 层）退化为复制 + 删除。
 *
 * Docker/containerd 默认的 overlayfs 挂载（redirect_dir=N）不会对目录做 copy-up：
 * 把镜像层里的目录 rename 到运行层会直接失败并返回 EXDEV（"cross-device link not
 * permitted"），这是官方镜像 + compose 部署下的必踩路径，不能假设 rename 一定成立。
 */
export function movePath(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
  }
  try {
    cpSync(from, to, { recursive: true, force: true, preserveTimestamps: true });
  } catch (error) {
    rmSync(to, { recursive: true, force: true });
    throw error;
  }
  rmSync(from, { recursive: true, force: true });
}

export function applyStagedBundle(input: {
  root: string;
  stagingDir: string;
  targetVersion: string;
  previousVersion: string;
  gitSha: string;
}): { backupDir: string } {
  const dir = otaDir(input.root);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(dir, `backup-${input.previousVersion}-${stamp}`);
  mkdirSync(backupDir, { recursive: true });

  const moved: Array<{ entry: string; toBackup: boolean }> = [];
  try {
    for (const entry of SWAP_ENTRIES) {
      const current = join(input.root, entry);
      const staged = join(input.stagingDir, entry);
      if (!existsSync(staged)) throw new Error(`暂存目录缺少 ${entry}`);
      if (existsSync(current)) {
        movePath(current, join(backupDir, entry));
        moved.push({ entry, toBackup: true });
      }
      movePath(staged, current);
      moved.push({ entry, toBackup: false });
    }
  } catch (error) {
    // 交换中途失败：尽力把已经动过的文件回位，避免半新半旧
    for (const item of moved.reverse()) {
      try {
        if (item.toBackup) {
          movePath(join(backupDir, item.entry), join(input.root, item.entry));
        } else {
          movePath(join(input.root, item.entry), join(input.stagingDir, item.entry));
        }
      } catch {
        // best effort
      }
    }
    throw error;
  }

  writeAppliedInfo(input.root, {
    status: 'pending',
    version: input.targetVersion,
    fromVersion: input.previousVersion,
    gitSha: input.gitSha,
    appliedAt: new Date().toISOString(),
    backupDir,
  });

  // 只保留最新一份备份
  for (const name of readdirSync(dir)) {
    if (name.startsWith('backup-')) {
      const full = join(dir, name);
      if (full !== backupDir) rmSync(full, { recursive: true, force: true });
    }
  }

  return { backupDir };
}

export function rollbackAppliedBundle(input: { root: string }): { toVersion: string } {
  const info = readAppliedInfo(input.root);
  if (!info || !existsSync(info.backupDir)) {
    throw new Error('没有可回滚的在线更新备份');
  }
  const dir = otaDir(input.root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const currentDir = join(dir, `rolled-back-${info.version}-${stamp}`);
  mkdirSync(currentDir, { recursive: true });

  for (const entry of SWAP_ENTRIES) {
    const current = join(input.root, entry);
    const backed = join(info.backupDir, entry);
    if (!existsSync(backed)) throw new Error(`备份缺少 ${entry}，无法回滚`);
    if (existsSync(current)) movePath(current, join(currentDir, entry));
    movePath(backed, current);
  }

  writeAppliedInfo(input.root, {
    ...info,
    status: 'rolled-back',
    rolledBackAt: new Date().toISOString(),
  });
  rmSync(info.backupDir, { recursive: true, force: true });
  return { toVersion: info.fromVersion };
}

function shSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * 生成提权执行脚本（pkexec / sudo 运行）。脚本职责：备份 → 替换 → 修复属主 → 写 applied.json。
 * 脚本位于暂存目录内，内容只由本服务生成（路径全部 shell 转义）。
 */
export function generateHostApplyScript(input: {
  root: string;
  stagingDir: string;
  backupDir: string;
  targetVersion: string;
  previousVersion: string;
  gitSha: string;
  runUid: number;
  runGid: number;
}): string {
  const q = shSingleQuote;
  const appliedRecord = `${JSON.stringify({
    status: 'pending',
    version: input.targetVersion,
    fromVersion: input.previousVersion,
    gitSha: input.gitSha,
    appliedAt: new Date().toISOString(),
    backupDir: input.backupDir,
  }, null, 2)}\n`;
  return `#!/bin/sh
# metapi 在线更新（宿主机模式）—— 由更新中心生成，需以 root 执行（pkexec 弹窗 / sudo）。
set -e

APP_ROOT=${q(input.root)}
STAGING=${q(input.stagingDir)}
BACKUP=${q(input.backupDir)}
RUN_UID=${input.runUid}
RUN_GID=${input.runGid}
OTA_DIR="$APP_ROOT/.ota"

if [ "$(id -u)" != "0" ]; then
  echo "需要 root 权限执行：sudo sh $0" >&2
  exit 1
fi

mkdir -p "$OTA_DIR" "$BACKUP"

owner_of() {
  if [ -e "$1" ]; then
    stat -c '%u:%g' "$1" 2>/dev/null || echo "$RUN_UID:$RUN_GID"
  else
    echo "$RUN_UID:$RUN_GID"
  fi
}

DIST_OWNER=$(owner_of "$APP_ROOT/dist")
DRIZZLE_OWNER=$(owner_of "$APP_ROOT/drizzle")
PKG_OWNER=$(owner_of "$APP_ROOT/package.json")

for entry in dist drizzle package.json; do
  if [ -e "$APP_ROOT/$entry" ]; then
    rm -rf "$BACKUP/$entry"
    mv "$APP_ROOT/$entry" "$BACKUP/$entry"
  fi
  mv "$STAGING/$entry" "$APP_ROOT/$entry"
done

chown -R "$DIST_OWNER" "$APP_ROOT/dist"
chown -R "$DRIZZLE_OWNER" "$APP_ROOT/drizzle"
chown "$PKG_OWNER" "$APP_ROOT/package.json"

# .ota 交给应用用户，后续状态读写不再需要 root
chown -R "$RUN_UID:$RUN_GID" "$OTA_DIR" 2>/dev/null || true

printf '%s' ${q(appliedRecord)} > "$OTA_DIR/applied.json"

# 只保留最新一份备份
for d in "$OTA_DIR"/backup-*; do
  [ -d "$d" ] || continue
  [ "$d" = "$BACKUP" ] || rm -rf "$d"
done

echo "metapi OTA applied: v${input.previousVersion} -> v${input.targetVersion}"
`;
}

/**
 * 清理 OTA 暂存物。
 *
 * 哈希资源（dist/web/assets/*-HASH.*）的清理策略：应用时整个 dist 目录被替换，
 * 新目录天然只含当前版本的哈希文件，不会累积；旧目录整体进入唯一的 backup-*，
 * 供回滚使用（下一次更新时被轮换删除）。这里额外清理的：暂存/下载残渣，以及
 * 回滚操作产生的 rolled-back-*（只保留最近一份，便于事后排查）。
 */
function cleanupOtaScratch(root: string): void {
  const dir = otaDir(root);
  if (!existsSync(dir)) return;
  const rolledBack: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('staging-') || name.startsWith('download-')) {
      rmSync(join(dir, name), { recursive: true, force: true });
      continue;
    }
    if (name.startsWith('rolled-back-')) rolledBack.push(name);
  }
  rolledBack.sort();
  while (rolledBack.length > 1) {
    const oldest = rolledBack.shift() as string;
    rmSync(join(dir, oldest), { recursive: true, force: true });
  }
}

function scheduleProcessExit(): void {
  if (String(process.env.METAPI_OTA_SKIP_RESTART || '') === '1') {
    setOtaState({ phase: 'restarting', message: '演练模式：跳过重启（METAPI_OTA_SKIP_RESTART=1）' });
    return;
  }
  const timer = setTimeout(() => {
    process.exit(0);
  }, 1500);
  timer.unref?.();
}

function finishHostApply(version: string, hostInfo: OtaHostInfo): void {
  if (hostInfo.supervised) {
    setOtaState({
      phase: 'restarting',
      message: `v${version} 已就位，进程即将重启加载新版本（检测到进程守护，将自动拉起）；重启后请刷新页面`,
      progressPct: 100,
      finishedAt: new Date().toISOString(),
    });
    scheduleProcessExit();
  } else {
    setOtaState({
      phase: 'restarting',
      message: `v${version} 已替换完成，但未检测到进程守护（systemd 等）；请手动重启 metapi 以加载新版本`,
      progressPct: 100,
      finishedAt: new Date().toISOString(),
    });
  }
}

export async function startOtaApply(version: string): Promise<void> {
  if (otaRunning) throw new Error('已有在线更新任务进行中');
  otaRunning = true;
  const root = resolveAppRoot();
  const mode = resolveOtaMode();
  const startedAt = new Date().toISOString();
  setOtaState({
    phase: 'downloading',
    message: `正在准备 v${version} 的在线更新`,
    version,
    progressPct: 0,
    error: undefined,
    command: undefined,
    startedAt,
    finishedAt: undefined,
  });

  try {
    if (mode === 'disabled') {
      throw new Error('在线更新未启用（非 Docker 部署且未设置 METAPI_OTA_HOST_MODE=1）');
    }
    cleanupOtaScratch(root);
    const running = readRunningPackageJson(root);
    if (running.version === version) {
      throw new Error(`当前已经是 v${version}`);
    }

    // 宿主机模式：先探测环境，决定暂存位置与提权路径
    const hostInfo = mode === 'host' ? collectOtaHostInfo(root) : null;
    const stagingBase = hostInfo && !hostInfo.writableAppRoot
      ? mkdtempSync(join(tmpdir(), 'metapi-ota-'))
      : otaDir(root);
    mkdirSync(stagingBase, { recursive: true });

    const location = await resolveBundleLocation(version);
    const downloadPath = join(stagingBase, `download-${version}.tar.gz`);
    await downloadBundle(location, downloadPath);

    setOtaState({ phase: 'verifying', message: '正在校验更新包', progressPct: undefined });
    const sidecar = await readSha256Sidecar(location);
    const digest = verifyBundleSha256(downloadPath, sidecar);

    const { stagingDir, manifest } = extractAndValidateBundle({
      root,
      tarballPath: downloadPath,
      targetVersion: version,
      stagingRoot: stagingBase,
    });

    const gitSha = manifest.gitSha || digest.slice(0, 12);

    if (mode === 'docker') {
      // Docker 容器路径：直接替换 + 退出由容器重启策略拉起
      setOtaState({ phase: 'applying', message: '正在替换应用文件' });
      applyStagedBundle({
        root,
        stagingDir,
        targetVersion: version,
        previousVersion: running.version,
        gitSha,
      });
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(downloadPath, { recursive: true, force: true });

      setOtaState({
        phase: 'restarting',
        message: `v${version} 已就位，进程即将重启加载新版本；重启后请刷新页面（旧页面引用的资源哈希会失效）`,
        progressPct: 100,
        finishedAt: new Date().toISOString(),
      });
      scheduleProcessExit();
      return;
    }

    // ── 宿主机模式：按提权阶梯执行 ──
    const host = hostInfo as OtaHostInfo;

    if (host.tier === 'direct') {
      setOtaState({ phase: 'applying', message: '正在替换应用文件（目录可写，零提权）' });
      applyStagedBundle({
        root,
        stagingDir,
        targetVersion: version,
        previousVersion: running.version,
        gitSha,
      });
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(downloadPath, { recursive: true, force: true });
      finishHostApply(version, host);
      return;
    }

    // 需要 root：生成提权脚本（pkexec 弹窗执行 / 交给管理员终端执行）
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = join(root, OTA_DIR_NAME, `backup-${running.version}-${stamp}`);
    const scriptPath = join(stagingDir, 'ota-apply.sh');
    writeFileSync(scriptPath, generateHostApplyScript({
      root,
      stagingDir,
      backupDir,
      targetVersion: version,
      previousVersion: running.version,
      gitSha,
      runUid: typeof process.getuid === 'function' ? process.getuid() : 0,
      runGid: typeof process.getgid === 'function' ? process.getgid() : 0,
    }), { mode: 0o755 });

    const manualCommand = `sudo sh ${scriptPath}`;

    if (host.tier === 'pkexec') {
      setOtaState({ phase: 'applying', message: '正在请求系统授权（polkit 授权窗），请完成授权…' });
      const result = spawnSync('pkexec', ['/bin/sh', scriptPath], {
        encoding: 'utf8',
        timeout: PKEXEC_TIMEOUT_MS,
      });
      if (result.status === 0) {
        rmSync(stagingDir, { recursive: true, force: true });
        rmSync(downloadPath, { recursive: true, force: true });
        finishHostApply(version, host);
        return;
      }
      const reason = result.error
        ? summarizeError(result.error)
        : result.status === 126
          ? '授权被取消或未通过（polkit）'
          : `提权脚本退出码 ${result.status ?? '未知'}`;
      setOtaState({
        phase: 'manual-required',
        message: `自动提权未完成（${reason}）。可复制以下命令在终端执行：`,
        command: manualCommand,
        finishedAt: new Date().toISOString(),
      });
      return;
    }

    // 无图形会话（真 headless）：交给管理员终端执行
    setOtaState({
      phase: 'manual-required',
      message: '未检测到图形会话，无法弹出系统授权窗。请复制以下命令在终端执行（sudo 会提示密码）：',
      command: manualCommand,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    setOtaState({
      phase: 'failed',
      message: '在线更新失败',
      error: summarizeError(error),
      finishedAt: new Date().toISOString(),
    });
    throw error;
  } finally {
    otaRunning = false;
  }
}

export async function startOtaRollback(): Promise<{ toVersion: string }> {
  if (otaRunning) throw new Error('已有在线更新任务进行中');
  otaRunning = true;
  try {
    const root = resolveAppRoot();
    if (resolveOtaMode() === 'host' && !probeAppRootWritable(root)) {
      throw new Error('宿主机模式下应用目录不可写，暂不支持自动回滚；请用 .ota/backup-* 手动恢复');
    }
    const result = rollbackAppliedBundle({ root });
    const supervised = resolveOtaMode() !== 'host' || isSupervisedRuntime();
    setOtaState({
      phase: 'restarting',
      message: supervised
        ? `已回滚到 v${result.toVersion}，进程即将重启`
        : `已回滚到 v${result.toVersion}；未检测到进程守护，请手动重启 metapi`,
      version: result.toVersion,
      finishedAt: new Date().toISOString(),
    });
    if (supervised) scheduleProcessExit();
    return result;
  } finally {
    otaRunning = false;
  }
}

export function getOtaStatusPayload(): {
  supported: boolean;
  supportedReason?: string;
  mode: OtaMode;
  host: OtaHostInfo | null;
  state: OtaState;
  applied: OtaAppliedInfo | null;
  rollbackAvailable: boolean;
} {
  const mode = resolveOtaMode();
  const support = getOtaSupport();
  const applied = readAppliedInfo();
  return {
    supported: support.supported,
    supportedReason: support.reason,
    mode,
    host: mode === 'host' && support.supported ? collectOtaHostInfo(resolveAppRoot()) : null,
    state: getOtaState(),
    applied,
    rollbackAvailable: Boolean(
      applied && applied.status === 'applied' && existsSync(applied.backupDir),
    ),
  };
}

/** 启动时收尾：把 pending 的应用记录标记为 applied，并写一条事件。 */
export async function finalizeOtaOnBoot(): Promise<void> {
  try {
    const root = resolveAppRoot();
    const info = readAppliedInfo(root);
    if (!info || info.status !== 'pending') return;

    writeAppliedInfo(root, { ...info, status: 'applied', verifiedAt: new Date().toISOString() });
    cleanupOtaScratch(root);

    const checkedAt = formatUtcSqlDateTime(new Date());
    await db.insert(schema.events).values({
      type: 'status',
      title: '在线更新已应用',
      message: `已从 v${info.fromVersion} 在线更新到 v${info.version}（OTA），可在更新中心查看或回滚。`,
      level: 'info',
      relatedType: 'update_center',
      createdAt: checkedAt,
    }).run();
  } catch (error) {
    console.warn('[update-center] OTA boot finalize failed:', summarizeError(error));
  }
}
