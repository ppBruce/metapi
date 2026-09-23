import { describe, expect, it } from 'vitest';
import { createBoundedCache } from './boundedCache.js';

describe('createBoundedCache', () => {
  it('stores and reads values, reports size', () => {
    const cache = createBoundedCache<string, number>(10);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBe(2);
    expect(cache.has('a')).toBe(true);
    expect(cache.get('missing')).toBeUndefined();
    expect(cache.has('missing')).toBe(false);
    expect(cache.size).toBe(2);
  });

  it('never grows past maxEntries and evicts the oldest key', () => {
    const cache = createBoundedCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    expect(cache.size).toBe(3);
    expect(cache.has('a')).toBe(false); // oldest evicted
    expect(cache.has('b')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('treats a re-set of an existing key as a refresh, protecting it from eviction', () => {
    const cache = createBoundedCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 11); // 'a' moves to the most-recent position
    cache.set('d', 4); // should evict 'b', not 'a'
    expect(cache.has('a')).toBe(true);
    expect(cache.get('a')).toBe(11);
    expect(cache.has('b')).toBe(false);
  });

  it('supports delete and clear', () => {
    const cache = createBoundedCache<string, number>(5);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    expect(cache.has('a')).toBe(false);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('clamps a non-positive or fractional limit to at least one entry', () => {
    const cache = createBoundedCache<string, number>(0);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size).toBe(1);
    expect(cache.has('b')).toBe(true);
  });
});
