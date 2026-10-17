type StatSparklineProps = {
  /** Numeric series, oldest first. Empty/undefined renders nothing. */
  values?: number[] | null;
  width?: number;
  height?: number;
  /** Any CSS color (var(--color-*) recommended). */
  color?: string;
};

/**
 * Sparkline for stat rows. Renders only when the series carries a real
 * signal: a constant or two-point series (e.g. a daily 0/1 check-in) has no
 * trend to show, and a flat line reads as "broken" rather than "stable".
 */
export default function StatSparkline({
  values,
  width = 72,
  height = 22,
  color = 'var(--color-primary)',
}: StatSparklineProps) {
  const series = (values || []).filter((v) => Number.isFinite(v));
  if (series.length < 3) return null;

  const max = Math.max(...series);
  const min = Math.min(...series);
  if (max === min) return null; // flat series: no trend worth drawing
  const range = max - min || 1;
  const pad = 3;
  const usableH = height - pad * 2;
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const toY = (v: number) => pad + (1 - (v - min) / range) * usableH;

  const points = series
    .map((v, i) => `${(i * stepX).toFixed(1)},${toY(v).toFixed(1)}`)
    .join(' ');
  const lastX = (series.length - 1) * stepX;
  const lastY = toY(series[series.length - 1]);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      style={{ flexShrink: 0, marginLeft: 'auto' }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.85}
      />
      <circle cx={lastX} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
