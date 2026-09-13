/**
 * OTA 应用包（app bundle）的清单定义与纯函数工具。
 *
 * 发布侧：`scripts/release/buildOtaBundle.ts` 用它生成随包的 `ota-manifest.json`；
 * 运行侧：更新中心的在线更新服务用它校验收到的包是否可以就地应用。
 *
 * 本文件保持纯函数（无文件系统/网络访问），以便发布脚本直接以 tsx 复用。
 */
import { createHash } from 'node:crypto';

export type OtaManifestFile = 'dist' | 'drizzle' | 'package.json' | 'package-lock.json';

export type OtaManifest = {
  schema: 1;
  version: string;
  gitSha: string;
  builtAt: string;
  nodeMajor: number;
  depsSignature: string;
  files: OtaManifestFile[];
};

export const OTA_MANIFEST_FILENAME = 'ota-manifest.json';
export const OTA_BUNDLE_FILES: OtaManifestFile[] = ['dist', 'drizzle', 'package.json', 'package-lock.json'];

type PackageManifestLike = {
  dependencies?: Record<string, string> | null;
  optionalDependencies?: Record<string, string> | null;
};

/**
 * 依赖签名：对「依赖名@声明范围」的有序列表取 sha256。
 *
 * 选择声明范围而不是 lock 文件，原因：容器内 node_modules 是 `npm ci --omit=dev`
 * 裁剪后的产物，与发布 lock 的全量树无法逐条对齐（跨平台可选依赖也不同）；
 * 而本仓库的依赖变更流程总会改动 package.json 的声明（新增/删除/升范围），
 * 用声明签名即可覆盖所有真实依赖变更场景，且发布侧/运行侧计算完全一致。
 */
export function computeDepsSignature(pkgJson: PackageManifestLike): string {
  const pairs: string[] = [];
  const add = (source?: Record<string, string> | null) => {
    if (!source || typeof source !== 'object') return;
    for (const [name, range] of Object.entries(source)) {
      if (typeof range === 'string' && name) pairs.push(`${name}@${range}`);
    }
  };
  add(pkgJson.dependencies);
  add(pkgJson.optionalDependencies);
  pairs.sort();
  const hash = createHash('sha256');
  for (const pair of pairs) hash.update(`${pair}\n`);
  return `sha256:${hash.digest('hex')}`;
}

export function buildOtaManifest(input: {
  version: string;
  gitSha: string;
  builtAt?: string;
  nodeMajor: number;
  pkgJson: PackageManifestLike;
}): OtaManifest {
  return {
    schema: 1,
    version: String(input.version || '').trim(),
    gitSha: String(input.gitSha || '').trim(),
    builtAt: input.builtAt || new Date().toISOString(),
    nodeMajor: input.nodeMajor,
    depsSignature: computeDepsSignature(input.pkgJson),
    files: [...OTA_BUNDLE_FILES],
  };
}

export function parseOtaManifest(raw: string | unknown): OtaManifest | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) return null;
  const version = typeof record.version === 'string' ? record.version.trim() : '';
  const depsSignature = typeof record.depsSignature === 'string' ? record.depsSignature.trim() : '';
  const nodeMajor = typeof record.nodeMajor === 'number' && Number.isInteger(record.nodeMajor) ? record.nodeMajor : null;
  if (!version || !depsSignature || nodeMajor === null) return null;
  const files = Array.isArray(record.files)
    ? record.files.filter((item): item is OtaManifestFile => OTA_BUNDLE_FILES.includes(item as OtaManifestFile))
    : [];
  return {
    schema: 1,
    version,
    gitSha: typeof record.gitSha === 'string' ? record.gitSha : '',
    builtAt: typeof record.builtAt === 'string' ? record.builtAt : '',
    nodeMajor,
    depsSignature,
    files: files.
      length > 0 ? files : [...OTA_BUNDLE_FILES],
  };
}

export type OtaCompatibilityCheck =
  | { ok: true }
  | { ok: false; reason: string };

/** 运行侧护栏：node 主版本 + 依赖签名必须与当前实例一致，否则不允许就地替换。 */
export function checkOtaCompatibility(
  manifest: OtaManifest,
  running: { nodeMajor: number; depsSignature: string },
): OtaCompatibilityCheck {
  if (manifest.nodeMajor !== running.nodeMajor) {
    return {
      ok: false,
      reason: `该版本需要 Node ${manifest.nodeMajor}（当前运行 Node ${running.nodeMajor}），请改用镜像更新`,
    };
  }
  if (manifest.depsSignature !== running.depsSignature) {
    return {
      ok: false,
      reason: '该版本包含依赖变更，无法就地更新，请改用镜像更新',
    };
  }
  return { ok: true };
}

export function resolveCurrentNodeMajor(): number {
  return Number.parseInt(process.versions.node.split('.')[0] || '0', 10);
}
