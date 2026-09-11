import { describe, expect, it } from 'vitest';
import { buildVisibleRouteList } from './routeListVisibility.js';
import { isExactTokenRouteModelPattern, matchesTokenRouteModelPattern } from '../../../shared/tokenRoutePatterns.js';

describe('routeListVisibility', () => {
  it('hides exact routes covered by an explicit group', () => {
    const routes = [
      {
        id: 1,
        modelPattern: 'gpt-5.5',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
      {
        id: 2,
        modelPattern: 'gpt-5.5-high',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
      {
        id: 3,
        modelPattern: 'gpt-5.5',
        displayName: 'gpt-5.5',
        routeMode: 'explicit_group',
        sourceRouteIds: [1, 2],
        enabled: true,
      },
    ];

    const visible = buildVisibleRouteList(
      routes,
      (pattern) => !pattern.includes('*') && !pattern.startsWith('re:'),
      (model, pattern) => {
        if (pattern.startsWith('re:')) return /^gpt-5\.5.*$/.test(model);
        return pattern === model;
      },
    );

    expect(visible.map((route) => route.id)).toEqual([3]);
  });

  it('hides exact routes covered by a regex group', () => {
    const routes = [
      {
        id: 1,
        modelPattern: 'gpt-5.5',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
      {
        id: 2,
        modelPattern: 'gpt-5.5-high',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
      {
        id: 3,
        modelPattern: 're:^gpt-5\\.5.*$',
        displayName: 'gpt-5.5',
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
    ];

    const visible = buildVisibleRouteList(
      routes,
      (pattern) => !pattern.includes('*') && !pattern.startsWith('re:'),
      (model, pattern) => {
        if (pattern.startsWith('re:')) return /^gpt-5\.5.*$/.test(model);
        return pattern === model;
      },
    );

    expect(visible.map((route) => route.id)).toEqual([3]);
  });

  it('keeps disabled exact routes visible when a group covers their model', () => {
    const routes = [
      {
        id: 1,
        modelPattern: 'gpt-5.5',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: false,
      },
      {
        id: 2,
        modelPattern: 're:^gpt-5.5.*$',
        displayName: 'gpt-5-group',
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
    ];

    const visible = buildVisibleRouteList(
      routes,
      (pattern) => !pattern.includes('*') && !pattern.startsWith('re:'),
      (model, pattern) => pattern.startsWith('re:') && /^gpt-5\.5.*$/.test(model),
    );

    expect(visible.map((route) => route.id)).toEqual([1, 2]);
  });

  it('hides an unnamed exact route when a covering pattern group has the same name', () => {
    const routes = [
      {
        id: 1,
        modelPattern: 'gpt-5',
        displayName: null,
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
      {
        id: 2,
        modelPattern: 're:^gpt-5.*$',
        displayName: 'gpt-5',
        routeMode: 'pattern',
        sourceRouteIds: [],
        enabled: true,
      },
    ];

    const visible = buildVisibleRouteList(
      routes,
      (pattern) => !pattern.includes('*') && !pattern.startsWith('re:'),
      (model, pattern) => pattern.startsWith('re:') && /^gpt-5.*$/.test(model),
    );

    expect(visible.map((route) => route.id)).toEqual([2]);
  });

  it.each([
    { routeMode: 'explicit_group', modelPattern: 'gpt-5', displayName: 'gpt-5', sourceRouteIds: [1, 2] },
    { routeMode: 'pattern', modelPattern: 'gpt-5*', displayName: 'gpt-5', sourceRouteIds: [] },
    { routeMode: 'pattern', modelPattern: 'gpt-5*', displayName: null, sourceRouteIds: [] },
  ])('groups named source routes by membership for $routeMode / $displayName', (group) => {
    const routes = [
      { id: 1, modelPattern: 'gpt-5', displayName: 'gpt-5', enabled: true },
      { id: 2, modelPattern: 'gpt-5-high', displayName: 'custom-alias', enabled: true },
      { id: 3, ...group, enabled: true },
      { id: 4, modelPattern: 'claude-sonnet', displayName: null, enabled: true },
    ];

    expect(buildVisibleRouteList(
      routes,
      isExactTokenRouteModelPattern,
      matchesTokenRouteModelPattern,
    ).map((route) => route.id)).toEqual([3, 4]);
  });

  it('keeps models visible when their only group is disabled', () => {
    const routes = [
      { id: 1, modelPattern: 'gpt-5', enabled: true },
      { id: 2, modelPattern: 'gpt-*', displayName: 'GPT', enabled: false },
    ];

    expect(buildVisibleRouteList(
      routes,
      isExactTokenRouteModelPattern,
      matchesTokenRouteModelPattern,
    ).map((route) => route.id)).toEqual([1, 2]);
  });
});
