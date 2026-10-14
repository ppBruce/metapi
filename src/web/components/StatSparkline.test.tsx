import { describe, expect, it } from 'vitest';
import { create, type ReactTestInstance } from 'react-test-renderer';
import StatSparkline from './StatSparkline.js';

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

describe('StatSparkline', () => {
  it('draws a trend when the series varies', () => {
    const root = create(<StatSparkline values={[1, 4, 2, 8]} />);
    expect(collectText(root.root)).toBe('');
    expect(root.root.findAll((n) => n.type === 'polyline')).toHaveLength(1);
    root.unmount();
  });

  it('hides itself for a series with no signal', () => {
    // A daily check-in count is 0/1: a flat or two-point line carries no
    // information and reads as broken rather than stable.
    for (const values of [[], [5], [3, 3], [0, 0, 0], [1, 1, 1, 1]]) {
      const root = create(<StatSparkline values={values} />);
      expect(root.toJSON()).toBeNull();
      root.unmount();
    }
  });

  it('ignores non-finite entries but still needs a varying series', () => {
    const root = create(<StatSparkline values={[1, Number.NaN, 5, 9]} />);
    expect(root.root.findAll((n) => n.type === 'polyline')).toHaveLength(1);
    root.unmount();
  });
});
