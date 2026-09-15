import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyStagedBundle,
  decideHostApplyTier,
  expireStaleOtaBackup,
  extractAndValidateBundle,
  generateHostApplyScript,
  getOtaStatusPayload,
  movePath,
  probeAppRootWritable,
  readAppliedInfo,
  rollbackAppliedBundle,
  verifyBundleSha256,
  withNetworkDownloadHint,
} from './updateCenterOtaService.js';
import { buildOtaManifest, OTA_MANIFEST_FILENAME } from './updateCenterOtaManifest.js';

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'metapi-ota-test-'));
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'metapi-ota-stage-'));
}

function writeAppTree(root: string, version: string, marker: string): void {
  mkdirSync(join(root, 'dist/server'), { recursive: true });
  writeFileSync(join(root, 'dist/server/index.js'), `console.log(${JSON.stringify(marker)});\n`);
  mkdirSync(join(root, 'drizzle'), { recursive: true });
  writeFileSync(join(root, 'drizzle/0000_init.sql'), `-- ${marker}\n`);
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ name: 'metapi', version, dependencies: { fastify: '^5.11.0' } }, null, 2)}\n`);
}

/** 找一个与 os.tmpdir() 不同设备的可写目录（用于制造真实 EXDEV）；不可用返回 null。 */
function detectCrossDeviceDir(): string | null {
  const candidate = '/dev/shm';
  try {
    if (!existsSync(candidate)) return null;
    const probeDir = mkdtempSync(join(candidate, 'metapi-ota-xdev-probe-'));
    const probeFile = join(probeDir, 'probe.txt');
    writeFileSync(probeFile, 'probe');
    const target = join(tmpdir(), `metapi-ota-xdev-${process.pid}.txt`);
    try {
      renameSync(probeFile, target);
      rmSync(target, { force: true });
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'EXDEV' ? candidate : null;
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  } catch {
    return null;
  }
}

describe('updateCenterOtaService', () => {
  it('verifies sha256 sidecars and rejects mismatches', () => {
    const dir = makeTempDir();
    try {
      const file = join(dir, 'bundle.tar.gz');
      writeFileSync(file, 'bundle-bytes');
      const digest = createHash('sha256').update(readFileSync(file)).digest('hex');

      expect(verifyBundleSha256(file, `${digest}  bundle.tar.gz\n`)).toBe(digest);
      expect(() => verifyBundleSha256(file, `${'0'.repeat(64)}  bundle.tar.gz\n`)).toThrow(/校验失败/);
      expect(() => verifyBundleSha256(file, 'not-a-digest')).toThrow(/格式无效/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies a staged bundle, records applied.json, and rolls back', () => {
    const root = makeTempRoot();
    const staging = makeTempDir();
    try {
      writeAppTree(root, '1.7.3', 'old');
      writeAppTree(staging, '1.7.4', 'new');

      const { backupDir } = applyStagedBundle({
        root,
        stagingDir: staging,
        targetVersion: '1.7.4',
        previousVersion: '1.7.3',
        gitSha: 'deadbeef',
      });

      expect(existsSync(backupDir)).toBe(true);
      expect(readFileSync(join(root, 'dist/server/index.js'), 'utf8')).toContain('"new"');
      const applied = readAppliedInfo(root);
      expect(applied?.status).toBe('pending');
      expect(applied?.version).toBe('1.7.4');
      expect(applied?.fromVersion).toBe('1.7.3');

      const rolled = rollbackAppliedBundle({ root });
      expect(rolled.toVersion).toBe('1.7.3');
      expect(readFileSync(join(root, 'dist/server/index.js'), 'utf8')).toContain('"old"');
      expect(readAppliedInfo(root)?.status).toBe('rolled-back');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('rejects staged bundles that fail the compatibility gate', () => {
    const root = makeTempRoot();
    const staging = makeTempDir();
    try {
      writeAppTree(root, '1.7.3', 'old');
      writeAppTree(staging, '9.9.9', 'new');
      // stage 的依赖签名与运行侧不一致（模拟依赖变更的版本）
      writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'metapi', version: '9.9.9', dependencies: { fastify: '^6.0.0' } }, null, 2)}\n`);
      const manifest = buildOtaManifest({
        version: '9.9.9',
        gitSha: 'abc',
        nodeMajor: Number.parseInt(process.versions.node.split('.')[0] || '0', 10),
        pkgJson: { dependencies: { fastify: '^6.0.0' } },
      });
      writeFileSync(join(staging, OTA_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
      execFileSync('tar', ['-czf', join(staging, 'bundle.tar.gz'), '-C', staging, 'dist', 'drizzle', 'package.json', OTA_MANIFEST_FILENAME]);

      expect(() => extractAndValidateBundle({
        root,
        tarballPath: join(staging, 'bundle.tar.gz'),
        targetVersion: '9.9.9',
      })).toThrow(/依赖变更|Node/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('extracts and validates a matching bundle', () => {
    const root = makeTempRoot();
    const staging = makeTempDir();
    try {
      writeAppTree(root, '1.7.4', 'old');
      writeAppTree(staging, '1.7.5', 'new');
      const manifest = buildOtaManifest({
        version: '1.7.5',
        gitSha: 'abc',
        nodeMajor: Number.parseInt(process.versions.node.split('.')[0] || '0', 10),
        pkgJson: { dependencies: { fastify: '^5.11.0' } },
      });
      writeFileSync(join(staging, OTA_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);
      execFileSync('tar', ['-czf', join(staging, 'bundle.tar.gz'), '-C', staging, 'dist', 'drizzle', 'package.json', OTA_MANIFEST_FILENAME]);

      const result = extractAndValidateBundle({
        root,
        tarballPath: join(staging, 'bundle.tar.gz'),
        targetVersion: '1.7.5',
      });
      expect(result.manifest.version).toBe('1.7.5');
      expect(existsSync(join(result.stagingDir, 'dist/server/index.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('picks the host apply tier: direct > pkexec > manual', () => {
    expect(decideHostApplyTier({ writableAppRoot: true, graphicalSession: false, pkexecAvailable: false })).toBe('direct');
    expect(decideHostApplyTier({ writableAppRoot: false, graphicalSession: true, pkexecAvailable: true })).toBe('pkexec');
    expect(decideHostApplyTier({ writableAppRoot: false, graphicalSession: true, pkexecAvailable: false })).toBe('manual');
    expect(decideHostApplyTier({ writableAppRoot: false, graphicalSession: false, pkexecAvailable: true })).toBe('manual');
  });

  it('attaches the actionable hint to transport-level download failures only', () => {
    // Without proxy configuration: the hint tells the operator what to set.
    // Clear every variant — shells commonly carry lowercase forms too.
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
      delete process.env[key];
    }
    expect(withNetworkDownloadHint(new Error('fetch failed'))).toContain('HTTPS_PROXY');
    expect(withNetworkDownloadHint(Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }))).toContain('HTTPS_PROXY');
    expect(withNetworkDownloadHint(Object.assign(new Error('fetch failed'), {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }))).toContain('METAPI_OTA_BUNDLE_DIR');

    // Other failure classes keep their own message untouched.
    expect(withNetworkDownloadHint(new Error('下载失败：HTTP 404'))).toBe('下载失败：HTTP 404');
    expect(withNetworkDownloadHint(new Error('更新包超出大小上限'))).toBe('更新包超出大小上限');

    // With a proxy configured the hint switches to a connectivity diagnosis.
    const restore = process.env.HTTPS_PROXY;
    try {
      process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
      expect(withNetworkDownloadHint(new Error('fetch failed'))).toContain('已配置系统代理');
      expect(withNetworkDownloadHint(new Error('fetch failed'))).not.toContain('METAPI_OTA_BUNDLE_DIR');
    } finally {
      if (restore === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = restore;
    }
  });

  it('detects app-root writability', () => {
    const root = makeTempRoot();
    const readonlyRoot = makeTempRoot();
    try {
      expect(probeAppRootWritable(root)).toBe(true);
      chmodSync(readonlyRoot, 0o555);
      expect(probeAppRootWritable(readonlyRoot)).toBe(false);
    } finally {
      chmodSync(readonlyRoot, 0o755);
      rmSync(root, { recursive: true, force: true });
      rmSync(readonlyRoot, { recursive: true, force: true });
    }
  });

  it('generates a syntactically valid elevation script with escaped paths', () => {
    const dir = makeTempDir();
    try {
      const script = generateHostApplyScript({
        root: '/opt/metapi test\'s dir',
        stagingDir: join(dir, 'staging'),
        backupDir: '/opt/metapi test\'s dir/.ota/backup-1.7.5-x',
        targetVersion: '1.7.6',
        previousVersion: '1.7.5',
        gitSha: 'abc123',
        runUid: 1000,
        runGid: 1000,
      });
      const scriptPath = join(dir, 'ota-apply.sh');
      writeFileSync(scriptPath, script, { mode: 0o755 });

      execFileSync('sh', ['-n', scriptPath], { stdio: 'pipe' });
      expect(script).toContain("test'\\''s");
      expect(script).toContain('"version": "1.7.6"');
      expect(script).toContain('sudo sh $0');

      const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
      if (uid !== 0) {
        expect(() => execFileSync('sh', [scriptPath], { stdio: 'pipe' })).toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // overlayfs（Docker 镜像层）目录无法 rename——用另一挂载点制造真实的 EXDEV
  // 复现，与容器内 "cross-device link not permitted" 同类（无可制造环境时跳过）。
  const crossDeviceDir = detectCrossDeviceDir();

  it.skipIf(!crossDeviceDir)('moves files and directories across devices when rename refuses with EXDEV', () => {
    const sourceDir = mkdtempSync(join(crossDeviceDir as string, 'metapi-ota-move-'));
    const destDir = makeTempDir();
    try {
      writeFileSync(join(sourceDir, 'package.json'), '{"name":"metapi"}\n');
      mkdirSync(join(sourceDir, 'dist/server'), { recursive: true });
      writeFileSync(join(sourceDir, 'dist/server/index.js'), 'console.log("moved");\n');

      movePath(join(sourceDir, 'package.json'), join(destDir, 'package.json'));
      movePath(join(sourceDir, 'dist'), join(destDir, 'dist'));

      expect(readFileSync(join(destDir, 'package.json'), 'utf8')).toContain('metapi');
      expect(readFileSync(join(destDir, 'dist/server/index.js'), 'utf8')).toContain('moved');
      expect(existsSync(join(sourceDir, 'package.json'))).toBe(false);
      expect(existsSync(join(sourceDir, 'dist'))).toBe(false);
    } finally {
      rmSync(sourceDir, { recursive: true, force: true });
      rmSync(destDir, { recursive: true, force: true });
    }
  });

  it.skipIf(!crossDeviceDir)('applies a staged bundle when the swap hits EXDEV', () => {
    const root = makeTempRoot();
    const staging = mkdtempSync(join(crossDeviceDir as string, 'metapi-ota-stage-'));
    try {
      writeAppTree(root, '1.7.3', 'old');
      writeAppTree(staging, '1.7.4', 'new');

      const { backupDir } = applyStagedBundle({
        root,
        stagingDir: staging,
        targetVersion: '1.7.4',
        previousVersion: '1.7.3',
        gitSha: 'deadbeef',
      });

      expect(readFileSync(join(root, 'dist/server/index.js'), 'utf8')).toContain('"new"');
      expect(readFileSync(join(backupDir, 'dist/server/index.js'), 'utf8')).toContain('"old"');
      expect(readAppliedInfo(root)?.status).toBe('pending');
      // 交换完成后 staging 不应再留有被交换的条目
      expect(existsSync(join(staging, 'dist'))).toBe(false);
      expect(existsSync(join(staging, 'drizzle'))).toBe(false);
      expect(existsSync(join(staging, 'package.json'))).toBe(false);

      // 回滚路径同样走 movePath
      const rolled = rollbackAppliedBundle({ root });
      expect(rolled.toVersion).toBe('1.7.3');
      expect(readFileSync(join(root, 'dist/server/index.js'), 'utf8')).toContain('"old"');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(staging, { recursive: true, force: true });
    }
  });

  it('drops the OTA rollback backup once the one-day window has passed', () => {
    const root = makeTempRoot();
    const prevRoot = process.env.METAPI_OTA_APP_ROOT;
    try {
      const backupDir = join(root, '.ota', 'backup-1.7.3-x');
      const writeBackup = () => {
        mkdirSync(join(backupDir, 'dist'), { recursive: true });
        writeFileSync(join(backupDir, 'dist', 'marker.txt'), 'old');
      };
      const writeApplied = (appliedAt: string) => writeFileSync(
        join(root, '.ota', 'applied.json'),
        `${JSON.stringify({
          status: 'applied',
          version: '1.7.4',
          fromVersion: '1.7.3',
          gitSha: 'x',
          appliedAt,
          backupDir,
        }, null, 2)}\n`,
      );

      writeBackup();
      writeApplied(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
      expireStaleOtaBackup(root);
      expect(existsSync(backupDir)).toBe(false);
      expect(readAppliedInfo(root)?.status).toBe('applied');

      // 状态查询同样顺手清理过期备份，并把回滚入口置为不可用
      process.env.METAPI_OTA_APP_ROOT = root;
      writeBackup();
      writeApplied(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
      expect(getOtaStatusPayload().rollbackAvailable).toBe(false);
      expect(existsSync(backupDir)).toBe(false);

      // 窗口内的备份保持可用
      writeBackup();
      writeApplied(new Date().toISOString());
      expect(getOtaStatusPayload().rollbackAvailable).toBe(true);
      expect(existsSync(backupDir)).toBe(true);
    } finally {
      if (prevRoot === undefined) delete process.env.METAPI_OTA_APP_ROOT;
      else process.env.METAPI_OTA_APP_ROOT = prevRoot;
      rmSync(root, { recursive: true, force: true });
    }
  });
});