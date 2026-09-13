/**
 * 构建 OTA 应用包（发布产物）：
 *
 *   metapi-<version>-app.tar.gz          dist + drizzle + package.json + package-lock.json + ota-manifest.json
 *   metapi-<version>-app.tar.gz.sha256   校验文件（`<hex>  <filename>` 格式）
 *
 * 用法（仓库根目录）：
 *   npx tsx scripts/release/buildOtaBundle.ts [--out <dir>] [--root <dir>]
 *
 * 前置：`npm run build:server` 与 `npm run build:web` 已执行（dist 存在）。
 * CI：release.yml 的 verify 任务在 Build 之后调用，产物随 artifacts 进入 Release Assets。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { buildOtaManifest, OTA_MANIFEST_FILENAME } from '../../src/server/services/updateCenterOtaManifest.js';

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

const root = resolve(argValue('--root') || process.cwd());
const outDir = resolve(argValue('--out') || join(root, 'release-assets'));

function fail(message: string): never {
  console.error(`[ota-bundle] ${message}`);
  process.exit(1);
}

const packageJsonPath = join(root, 'package.json');
if (!existsSync(packageJsonPath)) fail(`找不到 package.json：${packageJsonPath}`);
if (!existsSync(join(root, 'dist/server/index.js'))) fail('dist/server/index.js 不存在，请先执行 npm run build');
for (const file of ['drizzle', 'package-lock.json']) {
  if (!existsSync(join(root, file))) fail(`缺少 ${file}，无法打包`);
}

const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const version = String(pkg.version || '').trim();
if (!version) fail('package.json 缺少 version');

function resolveGitSha(): string {
  const fromEnv = String(process.env.GITHUB_SHA || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function resolveRuntimeNodeMajor(): number {
  const override = argValue('--node-major');
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  // OTA 包运行在 Docker 镜像内：node 主版本以 Dockerfile 的基础镜像为准。
  // （CI 构建机自身可能是别的 node 版本，不能直接采用构建机版本。）
  try {
    const dockerfile = readFileSync(join(root, 'docker/Dockerfile'), 'utf8');
    const match = dockerfile.match(/^FROM\s+node:(\d+)/m);
    if (match) return Number.parseInt(match[1], 10);
  } catch {
    // fall through to fail
  }
  fail('无法从 docker/Dockerfile 解析运行时 node 主版本，请使用 --node-major 指定');
}

const manifest = buildOtaManifest({
  version,
  gitSha: resolveGitSha(),
  nodeMajor: resolveRuntimeNodeMajor(),
  pkgJson: pkg,
});

const stageDir = join(root, '.ota-stage');
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const entry of ['dist', 'drizzle', 'package.json', 'package-lock.json']) {
  cpSync(join(root, entry), join(stageDir, entry), { recursive: true });
}
writeFileSync(join(stageDir, OTA_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(outDir, { recursive: true });
const tarball = join(outDir, `metapi-${version}-app.tar.gz`);
execFileSync(
  'tar',
  ['-czf', tarball, '-C', stageDir, 'dist', 'drizzle', 'package.json', 'package-lock.json', OTA_MANIFEST_FILENAME],
  { stdio: 'inherit' },
);

const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
writeFileSync(`${tarball}.sha256`, `${digest}  ${basename(tarball)}\n`);
rmSync(stageDir, { recursive: true, force: true });

console.log(`[ota-bundle] built ${tarball}`);
console.log(`[ota-bundle] sha256 ${digest}`);
console.log(`[ota-bundle] manifest ${JSON.stringify(manifest)}`);
