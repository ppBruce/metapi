import { describe, expect, it } from 'vitest';
import { create, type ReactTestInstance } from 'react-test-renderer';
import ChartLoadingState from './ChartLoadingState.js';

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => typeof child === 'string' ? child : collectText(child)).join('');
}

describe('ChartLoadingState', () => {
  it('renders only a spinner at the reserved height, with no shapes that could read as data', () => {
    const root = create(<ChartLoadingState height={300} />);
    const wrapper = root.root.children?.[0] as ReactTestInstance | undefined;
    expect(wrapper?.props?.style?.minHeight).toBe(300);
    expect(wrapper?.props?.['aria-busy']).toBe('true');

    const spinner = root.root.findByProps({ className: 'spinner' });
    expect(spinner.props?.role).toBe('status');
    expect(spinner.props?.['aria-label']).toBe('加载中');

    // Nothing else: no title bar, no grid lines, no axis stubs, no polyline.
    expect(collectText(root.root)).toBe('');
    expect(root.root.findAll((n) => n.props?.className === 'skeleton')).toHaveLength(0);
    expect(root.root.findAll((n) => n.type === 'polyline')).toHaveLength(0);
    root.unmount();
  });

  it('accepts the smaller plot height the dashboard fallback uses', () => {
    const root = create(<ChartLoadingState height={248} />);
    const wrapper = root.root.children?.[0] as ReactTestInstance | undefined;
    expect(wrapper?.props?.style?.minHeight).toBe(248);
    root.unmount();
  });
});
