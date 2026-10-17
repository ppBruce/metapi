import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import Sites from './Sites.js';

// The mobile pagination path (mobile-card-list) only renders under the mobile
// breakpoint; jsdom's default viewport is desktop-wide.
vi.mock('../components/useIsMobile.js', () => ({
  useIsMobile: () => true,
}));

// MobileCard is presentational only. This stand-in keeps the rendered text (so
// the page-row assertions still work) and records every card the list ever
// renders. The reported bug is a WRONG PAGE PAINTED FOR A FRAME — the final
// state is correct either way, so only a render log can catch it.
const { cardRenderLog } = vi.hoisted(() => ({ cardRenderLog: [] as string[] }));
function nodeText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  const props = (node as { props?: { children?: unknown } }).props;
  return props ? nodeText(props.children) : '';
}
vi.mock('../components/MobileCard.js', async () => {
  const React = await import('react');
  return {
    MobileCard: ({ title }: { title?: ReactNode }) => {
      cardRenderLog.push(nodeText(title));
      return React.createElement('div', { className: 'mobile-card' }, title);
    },
    MobileField: () => null,
  };
});

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getOAuthProviders: vi.fn().mockResolvedValue({ providers: [] }),
    getSiteAvailableModels: vi.fn().mockResolvedValue({ models: [] }),
  },
}));
vi.mock('../api.js', () => ({ api: apiMock }));

const records = Array.from({ length: 15 }, (_, i) => ({
  id: i + 1, name: `SITE-${String(i + 1).padStart(2, '0')}`,
  url: `https://site${i + 1}.example.com`, platform: 'new-api', status: 'active',
  totalBalance: (15 - i) * 100,
}));
let latestSearch = '';
function LocationObserver() {
  latestSearch = useLocation().search;
  return null;
}
type TestRenderer = ReturnType<typeof create>;
function text(node: ReactTestInstance): string {
  return node.children.map((child) => typeof child === 'string' ? child : text(child)).join('');
}
function pageRows(root: TestRenderer): string[] {
  const mobileList = root.root.findAll((node: ReactTestInstance) => node.type === 'div' && node.props.className === 'mobile-card-list')[0];
  if (!mobileList) return [];
  // Anchor on the card itself: the drag wrapper drops its `site-card-draggable`
  // class outside custom sort (the row is not draggable then).
  return mobileList.findAll((node: ReactTestInstance) => (
    node.type === 'div'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('mobile-card')
  )).map(text);
}
function activePage(root: TestRenderer): string | null {
  const btn = root.root.findAll((node: ReactTestInstance) => node.type === 'button'
    && typeof node.props.className === 'string'
    && node.props.className.split(' ').includes('active')
    && node.props.className.includes('pagination-btn'))[0];
  return btn ? text(btn).trim() : null;
}
function emptyStateVisible(root: TestRenderer): boolean {
  return root.root.findAll((node: ReactTestInstance) => node.type === 'div'
    && node.props.className === 'empty-state').length > 0;
}
function sortSelect(root: TestRenderer) {
  return root.root.findAll((node: ReactTestInstance) => (
    node.type === ModernSelect
    && (node.props.options || []).some((o: { value: string }) => o.value === 'balance-desc')
  ))[0] as ReactTestInstance;
}
function openMobileTools(root: TestRenderer) {
  return root.root.find((node: ReactTestInstance) => node.type === 'button'
    && text(node).trim() === '排序与操作');
}
async function render(initialEntry: string) {
  let root!: TestRenderer;
  await act(async () => {
    root = create(<MemoryRouter initialEntries={[initialEntry]}><LocationObserver /><ToastProvider><Sites /></ToastProvider></MemoryRouter>);
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return root;
}

describe('Sites pagination stays on the URL page across a remount data refill', () => {
  beforeEach(() => {
    latestSearch = '';
    cardRenderLog.length = 0;
    apiMock.getSites.mockResolvedValue(records);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('never paints page 1 when the list data arrives after mounting on ?page=N', async () => {
    // Back-navigation / reload timeline: the component mounts while getSites
    // is still in flight (page state starts at URL page 3), then data arrives.
    let resolveSites!: (rows: typeof records) => void;
    apiMock.getSites.mockImplementation(() => new Promise((resolve) => { resolveSites = resolve; }));
    const root = await render('/sites?page=3');
    try {
      // Data still loading: no page-1 rows may be visible, and the empty
      // state must not masquerade as "no sites" while loading.
      expect(pageRows(root).some((x) => x.includes('SITE-01'))).toBe(false);
      expect(emptyStateVisible(root)).toBe(false);

      await act(async () => { resolveSites(records); await Promise.resolve(); await Promise.resolve(); });

      // Data arrived: must land directly on page 3 — never paint page 1.
      const rows = pageRows(root);
      expect(rows.length).toBe(5);
      expect(rows.some((x) => x.includes('SITE-11'))).toBe(true);
      expect(rows.some((x) => x.includes('SITE-01'))).toBe(false);
      expect(activePage(root)).toBe('3');
      expect(latestSearch).toBe('?page=3');
      // The render log is the regression guard: the old resetKey included the
      // list length, so the 0→N refill reset the hook to page 1 and the first
      // page was rendered (and painted on a slow device) before the URL page
      // was restored. Page-1 cards must never be rendered at all here.
      expect(cardRenderLog.some((name) => /SITE-0[1-5]/.test(name))).toBe(false);
      expect(cardRenderLog.some((name) => /SITE-1[1-5]/.test(name))).toBe(true);
    } finally { await act(async () => { root.unmount(); }); }
  });

  it('clears the stale ?page when a sort change resets pagination to page 1', async () => {
    // A sort change legitimately resets the hook to page 1 (resetKey bump). If
    // the URL still carries ?page=N, the page-sync effect drags the state back
    // — the "old page ↔ new page" bounce. The URL must be cleared in the same
    // user action, exactly like the page-size change path already does.
    const root = await render('/sites?page=2');
    try {
      expect(activePage(root)).toBe('2');
      await act(async () => { openMobileTools(root).props.onClick(); });
      const select = sortSelect(root);
      await act(async () => { select.props.onChange('balance-desc'); });
      expect(latestSearch).toBe('');
      expect(activePage(root)).toBe('1');
      // And the view must stay on page 1 (no bounce back to page 2).
      expect(pageRows(root).some((x) => x.includes('SITE-01'))).toBe(true);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      expect(activePage(root)).toBe('1');
      expect(latestSearch).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  });
});
