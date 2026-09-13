/**
 * 更新中心「在线更新」（OTA，dist 热替换）。
 *
 * 机制：从 GitHub Release 下载应用包（dist + drizzle + package.json + 清单），
 * 校验 sha256 与依赖 / Node 兼容性后，把当前应用文件整体搬到备份目录、把新文件
 * 换入原地，最后退出进程、由容器重启策略（restart: unless-stopped）拉起新版本；
 * 容器启动命令本来就会先跑迁移（`node dist/server/db/migrate.js`）。
 *
 * 设计边界（评估见仓库根目录的 OTA 评估文档）：
 * - 仅 Docker 部署开放（`/.dockerenv` 探测；演练/开发用 METAPI_OTA_ALLOW_NON_DOCKER=1）。
 * - 依赖发生变更的版本由 depsSignature 拦下，引导走镜像更新（见 updateCenterOtaManifest）。
 * - 容器被重建时写入层丢失，会回到镜像基线版本——更新中心如实展示（applied.json 随层消失）。
 * - 备份保留在 <appRoot>/.ota/backup-*，支持一键回滚。
 *
 * 测试/演练环境变量（仅内部使用）：
 * - METAPI_OTA_APP_ROOT            指定应用根（默认 process.cwd()）
 * - METAPI_OTA_ALLOW_NON_DOCKER=1  允许非 Docker 环境应用（演练用）
 * - METAPI_OTA_SKIP_RESTART=1      应用后不退出进程（演练用）
 * - METAPI_OTA_BUNDLE_DIR          从本地目录取包，跳过 GitHub（演练用）
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

export type OtaPhase = 'idle' | 'downloading' | 'verifying' | 'applying' | 'restarting' | 'failed';

export type OtaState = {
  phase: OtaPhase;
  message: string;
  version?: string;
  progressPct?: number;
  error?: string;
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

export function getOtaSupport(): { supported: boolean; reason?: string } {
  if (!isDockerRuntime()) {
    return { supported: false, reason: '在线更新仅在 Docker / Compose 部署下开放' };
  }
  const root = resolveAppRoot();
  if (!existsSync(join(root, 'package.json')) || !existsSync(join(root, 'dist/server/index.js'))) {
    return { supported: false, reason: '应用目录结构不符合预期，无法在线更新' };
  }
  return { supported: true };
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
}): { stagingDir: string; manifest: OtaManifest } {
  const dir = otaDir(input.root);
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
        renameSync(current, join(backupDir, entry));
        moved.push({ entry, toBackup: true });
      }
      renameSync(staged, current);
      moved.push({ entry, toBackup: false });
    }
  } catch (error) {
    // 交换中途失败：尽力把已经动过的文件回位，避免半新半旧
    for (const item of moved.reverse()) {
      try {
        if (item.toBackup) {
          renameSync(join(backupDir, item.entry), join(input.root, item.entry));
        } else {
          renameSync(join(input.root, item.entry), join(input.stagingDir, item.entry));
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
    if (existsSync(current)) renameSync(current, join(currentDir, entry));
    renameSync(backed, current);
  }

  writeAppliedInfo(input.root, {
    ...info,
    status: 'rolled-back',
    rolledBackAt: new Date().toISOString(),
  });
  rmSync(info.backupDir, { recursive: true, force: true });
  return { toVersion: info.fromVersion };
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

export async function startOtaApply(version: string): Promise<void> {
  if (otaRunning) throw new Error('已有在线更新任务进行中');
  otaRunning = true;
  const root = resolveAppRoot();
  const startedAt = new Date().toISOString();
  setOtaState({
    phase: 'downloading',
    message: `正在准备 v${version} 的在线更新`,
    version,
    progressPct: 0,
    error: undefined,
    startedAt,
    finishedAt: undefined,
  });

  try {
    cleanupOtaScratch(root);
    const running = readRunningPackageJson(root);
    if (running.version === version) {
      throw new Error(`当前已经是 v${version}`);
    }

    const location = await resolveBundleLocation(version);
    const downloadPath = join(otaDir(root), `download-${version}.tar.gz`);
    mkdirSync(otaDir(root), { recursive: true });
    await downloadBundle(location, downloadPath);

    setOtaState({ phase: 'verifying', message: '正在校验更新包', progressPct: undefined });
    const sidecar = await readSha256Sidecar(location);
    const digest = verifyBundleSha256(downloadPath, sidecar);

    const { stagingDir, manifest } = extractAndValidateBundle({
      root,
      tarballPath: downloadPath,
      targetVersion: version,
    });

    setOtaState({ phase: 'applying', message: '正在替换应用文件' });
    applyStagedBundle({
      root,
      stagingDir,
      targetVersion: version,
      previousVersion: running.version,
      gitSha: manifest.gitSha || digest.slice(0, 12),
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
    const result = rollbackAppliedBundle({ root });
    setOtaState({
      phase: 'restarting',
      message: `已回滚到 v${result.toVersion}，进程即将重启`,
      version: result.toVersion,
      finishedAt: new Date().toISOString(),
    });
    scheduleProcessExit();
    return result;
  } finally {
    otaRunning = false;
  }
}

export function getOtaStatusPayload(): {
  supported: boolean;
  supportedReason?: string;
  state: OtaState;
  applied: OtaAppliedInfo | null;
  rollbackAvailable: boolean;
} {
  const support = getOtaSupport();
  const applied = readAppliedInfo();
  return {
    supported: support.supported,
    supportedReason: support.reason,
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
