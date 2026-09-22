import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import SiteTrendChart from './SiteTrendChart.js';

const { apiMock, vChartSpy } = vi.hoisted(() => ({
  apiMock: { getSiteTrend: vi.fn() },
  vChartSpy: vi.fn(),
}));

vi.mock('../../api.js', () => ({ api: apiMock }));

vi.mock('@visactor/react-vchart', () => ({
  VChart: (props: Record<string, unknown>) => {
    vChartSpy(props);
    return null;
  },
}));

type Spec = {
  axes: Array<{ orient: string; label?: { formatMethod?: (v: unknown) => string } }>;
  tooltip: {
    mark: { title: { value: (d: Record<string, unknown>) => string } };
    dimension: { title: { value: (d: Record<string, unknown>) => string } };
  };
  data: Array<{ values: Array<{ date: string; site: string; value: number }> }>;
  seriesField: string;
};

/** The most recent spec the chart handed to VChart. */
function latestSpec(): Spec {
  // Take the last call that actually carried props: React also invokes the
  // component on paths that record a call with no arguments.
  const withSpec = vChartSpy.mock.calls.filter((call) => call[0] && (call[0] as { spec?: unknown }).spec);
  return (withSpec[withSpec.length - 1][0] as { spec: Spec }).spec;
}

function axisLabel(spec: Spec, value: string): string | undefined {
  const bottom = spec.axes.find((axis) => axis.orient === 'bottom');
  return bottom?.label?.formatMethod?.(value) as string | undefined;
}

describe('SiteTrendChart', () => {
  beforeEach(() => {
    vChartSpy.mockClear();
    apiMock.getSiteTrend.mockReset();
  });

  async function render(): Promise<ReactTestRenderer> {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<SiteTrendChart />);
    });
    // The component swaps its loading skeleton for the chart once the API promise
    // settles. Flush real macrotask ticks (not just microtasks) until the spec has
    // reached VChart, so this does not depend on how many other tests ran first.
    for (let attempt = 0; attempt < 20 && vChartSpy.mock.calls.length === 0; attempt += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    return renderer;
  }

  it('labels hourly buckets with the local hour the payload carries', async () => {
    // The server sends a LOCAL wall-clock label ("YYYY-MM-DD HH:00"); the axis
    // prints the hour verbatim, so it must not re-interpret it as UTC.
    apiMock.getSiteTrend.mockResolvedValue({
      trend: [
        { date: '2026-09-21 16:00', sites: { 'Demo Site': { spend: 1.5, calls: 3 } } },
        { date: '2026-09-21 17:00', sites: { 'Demo Site': { spend: 2, calls: 4 } } },
      ],
    });

    const renderer = await render();
    const spec = latestSpec();

    expect(axisLabel(spec, '2026-09-21 16:00')).toBe('16');
    expect(axisLabel(spec, '2026-09-21 17:00')).toBe('17');
    // A full timestamp reaching the axis is trimmed to the hour, not printed raw.
    expect(axisLabel(spec, '2026-09-21 16:00:00')).toBe('16');
    renderer.unmount();
  });

  it('labels daily buckets as month-day', async () => {
    apiMock.getSiteTrend.mockResolvedValue({
      trend: [{ date: '2026-09-21', sites: { 'Demo Site': { spend: 1, calls: 1 } } }],
    });

    const renderer = await render();
    expect(axisLabel(latestSpec(), '2026-09-21')).toBe('09-21');
    renderer.unmount();
  });

  it('uses the same label for the tooltip title as for the axis', async () => {
    apiMock.getSiteTrend.mockResolvedValue({
      trend: [{ date: '2026-09-21 16:00', sites: { 'Demo Site': { spend: 1.5, calls: 3 } } }],
    });

    const renderer = await render();
    const spec = latestSpec();
    const datum = { date: '2026-09-21 16:00', site: 'Demo Site', value: 1.5 };

    // Both tooltip modes are configured; a click resolves to the dimension one.
    expect(spec.tooltip.mark.title.value(datum)).toBe('16');
    expect(spec.tooltip.dimension.title.value(datum)).toBe('16');
    renderer.unmount();
  });

  it('flattens the payload into one series point per site per bucket', async () => {
    apiMock.getSiteTrend.mockResolvedValue({
      trend: [
        { date: '2026-09-21 16:00', sites: { A: { spend: 1, calls: 10 }, B: { spend: 2, calls: 20 } } },
        { date: '2026-09-21 17:00', sites: { A: { spend: 3, calls: 30 } } },
      ],
    });

    const renderer = await render();
    const values = latestSpec().data[0].values;

    expect(values).toHaveLength(3);
    expect(values).toContainEqual({ date: '2026-09-21 16:00', site: 'A', value: 1 });
    expect(values).toContainEqual({ date: '2026-09-21 16:00', site: 'B', value: 2 });
    expect(values).toContainEqual({ date: '2026-09-21 17:00', site: 'A', value: 3 });
    renderer.unmount();
  });

  it('requests the selected window from the API', async () => {
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    const renderer = await render();
    expect(apiMock.getSiteTrend).toHaveBeenCalledWith(1);
    renderer.unmount();
  });

  it('shows the empty state instead of an empty chart', async () => {
    apiMock.getSiteTrend.mockResolvedValue({ trend: [] });
    const renderer = await render();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('暂无趋势数据');
    renderer.unmount();
  });
});
