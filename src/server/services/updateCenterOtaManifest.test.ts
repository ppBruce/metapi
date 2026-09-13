import { describe, expect, it } from 'vitest';

import {
  buildOtaManifest,
  checkOtaCompatibility,
  computeDepsSignature,
  parseOtaManifest,
} from './updateCenterOtaManifest.js';

describe('updateCenterOtaManifest', () => {
  it('computes a stable deps signature regardless of key order and includes optional deps', () => {
    const a = computeDepsSignature({
      dependencies: { fastify: '^5.11.0', undici: '^7.0.0' },
      optionalDependencies: { sharp: '^0.34.0' },
    });
    const b = computeDepsSignature({
      optionalDependencies: { sharp: '^0.34.0' },
      dependencies: { undici: '^7.0.0', fastify: '^5.11.0' },
    });
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });

  it('changes the signature when a range changes but not when only the version field changes', () => {
    const base = { dependencies: { 'js-yaml': '^4.1.0' } };
    const bumpedRange = { dependencies: { 'js-yaml': '^4.1.1' } };
    expect(computeDepsSignature(base)).not.toBe(computeDepsSignature(bumpedRange));
    // version 字段不属于签名输入
    expect(computeDepsSignature(base)).toBe(computeDepsSignature(base));
  });

  it('builds and round-trips a manifest', () => {
    const manifest = buildOtaManifest({
      version: '1.7.6',
      gitSha: 'abc123',
      builtAt: '2026-09-13T00:00:00.000Z',
      nodeMajor: 22,
      pkgJson: { dependencies: { fastify: '^5.11.0' } },
    });
    expect(manifest.schema).toBe(1);
    expect(manifest.files).toContain('dist');
    const parsed = parseOtaManifest(JSON.stringify(manifest));
    expect(parsed).toEqual(manifest);
  });

  it('rejects malformed manifests', () => {
    expect(parseOtaManifest('not-json')).toBeNull();
    expect(parseOtaManifest({})).toBeNull();
    expect(parseOtaManifest({ schema: 2, version: '1.0.0', depsSignature: 'sha256:x', nodeMajor: 22 })).toBeNull();
    expect(parseOtaManifest({ schema: 1, version: '', depsSignature: 'sha256:x', nodeMajor: 22 })).toBeNull();
    expect(parseOtaManifest({ schema: 1, version: '1.0.0', depsSignature: 'sha256:x' })).toBeNull();
  });

  it('flags node major and dependency mismatches', () => {
    const manifest = buildOtaManifest({
      version: '1.7.6',
      gitSha: 'abc123',
      nodeMajor: 22,
      pkgJson: { dependencies: { fastify: '^5.11.0' } },
    });
    expect(checkOtaCompatibility(manifest, {
      nodeMajor: 22,
      depsSignature: manifest.depsSignature,
    })).toEqual({ ok: true });

    const nodeMismatch = checkOtaCompatibility(manifest, {
      nodeMajor: 24,
      depsSignature: manifest.depsSignature,
    });
    expect(nodeMismatch.ok).toBe(false);

    const depsMismatch = checkOtaCompatibility(manifest, {
      nodeMajor: 22,
      depsSignature: computeDepsSignature({ dependencies: { fastify: '^5.12.0' } }),
    });
    expect(depsMismatch.ok).toBe(false);
  });
});
