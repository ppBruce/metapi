import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetTieredExprSandboxForTests,
  evaluateTieredExprInSandbox,
} from './tieredExprSandbox.js';

const ZERO = { p: 0, c: 0, len: 0, cr: 0, cc: 0, cc1h: 0, img: 0, img_o: 0, ai: 0, ao: 0 };

function evalExpr(expr: string, params: Partial<typeof ZERO> = {}) {
  return evaluateTieredExprInSandbox(expr, { ...ZERO, ...params });
}

describe('tiered expression sandbox', () => {
  beforeEach(() => {
    __resetTieredExprSandboxForTests();
  });

  describe('pricing semantics are preserved', () => {
    it('evaluates the upstream luna tiered bill', () => {
      const expr = 'len <= 272000 ? tier("<=272K", p * 1 + c * 6 + cr * 0.1) : tier(">272K", p * 2 + c * 9 + cr * 0.2)';

      const small = evalExpr(expr, { p: 77995, c: 130, len: 78125 });
      expect(small.cost).toBeCloseTo(78775, 4);
      expect(small.tier).toBe('<=272K');

      const large = evalExpr(expr, { p: 300_000, c: 10_000, len: 310_000 });
      expect(large.cost).toBeCloseTo(690_000, 4);
      expect(large.tier).toBe('>272K');
    });

    it('supports fixed() per-request pricing', () => {
      expect(evalExpr('tier("request", fixed(1))').cost).toBeCloseTo(1_000_000, 6);
    });

    it('exposes the documented token variables', () => {
      const result = evalExpr('tier("extended", p + c + cc + cc1h + img + img_o + ai + ao)', {
        p: 1, c: 2, cc: 3, cc1h: 4, img: 5, img_o: 6, ai: 7, ao: 8,
      });
      expect(result.cost).toBe(36);
    });

    it('supports the math helpers', () => {
      // abs(-9)=9, ceil(3.2)=4 → min=4; floor(4.9)=4 → 4+4=8; max(8,1)=8
      expect(evalExpr('tier("m", max(min(abs(-9), ceil(3.2)) + floor(4.9), 1))').cost).toBe(8);
    });

    it('supports has()', () => {
      expect(evalExpr('tier("h", has("abcdef", "cde") ? 1 : 0)').cost).toBe(1);
    });

    it('supports the time helpers with an IANA zone', () => {
      const result = evalExpr('hour("UTC") >= 0 ? tier("time", p + c) : tier("fallback", 0)', { p: 5, c: 6 });
      expect(result.cost).toBe(11);
      expect(result.tier).toBe('time');
    });

    it('resolves request-context probes to neutral values', () => {
      // No request body is available at billing time, so these are empty strings
      // and the expression takes its fallback branch.
      expect(evalExpr('tier("probe", header("x-a") === "" && param("y") === "" ? 1 : 0)').cost).toBe(1);
    });

    it('reports a non-finite result as an error', () => {
      expect(() => evalExpr('tier("bad", 1 / 0)')).toThrow(/non-finite/);
    });

    it('reports a malformed expression as an error instead of billing zero', () => {
      expect(() => evalExpr('this is not an expression')).toThrow();
    });
  });

  describe('the expression cannot reach the host process', () => {
    it('has no process / require / fetch in scope', () => {
      // `typeof` on an undeclared identifier yields "undefined"; assert all three
      // are absent at once, and that the sandbox did NOT get the host objects.
      const absent = evalExpr(`
        tier("probe",
          (typeof process === "undefined" ? 1 : 0)
          + (typeof require === "undefined" ? 2 : 0)
          + (typeof fetch === "undefined" ? 4 : 0))
      `);
      expect(absent.cost).toBe(7);
      expect(absent.tier).toBe('probe');

      // Sanity: the host really does have these, so the assertion above is meaningful.
      expect(typeof process).toBe('object');
      expect(typeof fetch).toBe('function');
    });

    it('blocks eval() and the Function constructor', () => {
      expect(() => evalExpr('tier("x", eval("1+1"))')).toThrow(/code generation/i);
      expect(() => evalExpr('tier("x", Function("return 1")())')).toThrow(/code generation/i);
      expect(() => evalExpr('tier("x", ({}).constructor.constructor("return process")())'))
        .toThrow(/code generation/i);
    });

    it('cannot read environment variables', () => {
      // The classic exfil shape: build a function from a string to get a real
      // global scope. Blocked at the string-codegen layer.
      expect(() => evalExpr('tier("x", (function(){}).constructor("return process.env")())'))
        .toThrow(/code generation/i);
    });

    it('interrupts a runaway expression instead of hanging the process', () => {
      // The whole call runs through runInContext, so the vm timeout applies.
      expect(() => evalExpr('tier("loop", (() => { while (true) {} })())')).toThrow(/timed out/i);
    });
  });

  describe('compilation cache', () => {
    it('reuses a compiled expression and keeps reporting its tier', () => {
      const expr = 'tier("cached", p * 2)';
      expect(evalExpr(expr, { p: 3 }).cost).toBe(6);
      expect(evalExpr(expr, { p: 4 }).cost).toBe(8);
      expect(evalExpr(expr, { p: 5 }).tier).toBe('cached');
    });
  });
});
