import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyStagedBundle,
  decideHostApplyTier,
  extractAndValidateBundle,
  generateHostApplyScript,
  probeAppRootWritable,
  readAppliedInfo,
  rollbackAppliedBundle,
  verifyBundleSha256,
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
        root: `/opt/metapi test's dir`,
        stagingDir: join(dir, 'staging'),
        backupDir: `/opt/metapi test's dir/.ota/backup-1.7.5-x`,
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
});
