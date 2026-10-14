import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import { DndContext } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableAccountMobileCard, SortableAccountTableRow } from './SortableAccountItems.js';

describe('account sortable surfaces', () => {
  it('keeps the desktop row a table row with drag semantics and a caller ref', async () => {
    let root!: WebTestRenderer;
    const rowRef = vi.fn();
    await act(async () => {
      root = create(
        <DndContext>
          <SortableContext items={[42]} strategy={verticalListSortingStrategy}>
            <table><tbody>
              <SortableAccountTableRow id={42} label="Demo" disabled={false} className="row" dataTestId="account-row-42" rowRef={rowRef}>
                <td>Demo</td>
              </SortableAccountTableRow>
            </tbody></table>
          </SortableContext>
        </DndContext>,
      );
    });
    try {
      const row = root.root.findByType('tr');
      expect(row.props['aria-label']).toBe('拖拽调整「Demo」的顺序');
      expect(row.props['data-testid']).toBe('account-row-42');
      expect(row.props.className).toContain('site-row-draggable');
      expect(row.props.role).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('keeps the mobile card disabled without a drag label', async () => {
    let root!: WebTestRenderer;
    await act(async () => {
      root = create(
        <DndContext>
          <SortableContext items={[42]} strategy={verticalListSortingStrategy}>
            <SortableAccountMobileCard id={42} label="Demo" disabled isDropTarget={false}>
              <span>Demo</span>
            </SortableAccountMobileCard>
          </SortableContext>
        </DndContext>,
      );
    });
    try {
      const card = root.root.find((node) => node.type === 'div' && node.props.style?.position === 'relative');
      expect(card.props['aria-label']).toBeUndefined();
      expect(card.props.tabIndex).toBeUndefined();
      expect(card.props.className).not.toContain('site-card-draggable');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
