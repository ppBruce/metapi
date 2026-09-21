import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Sites mobile layout', () => {
  it('drags the whole card instead of a handle or move arrows', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');
    expect(source).toContain('mobile-card');
    // The whole row/card is the drag surface: no handle button, no arrows.
    expect(source).not.toContain('site-drag-handle');
    expect(source).not.toContain('handleMoveCustomOrder');
    expect(source).toContain('site-card-draggable');
    expect(source).toContain('site-row-draggable');
    // The row itself moves at its own size; there is no floating copy.
    expect(source).not.toContain('DragOverlay');
    expect(source).not.toContain('site-drag-overlay');
  });

  it('keeps the sensors from stealing row clicks and list scrolling', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Sites.tsx'), 'utf8');
    // mouse: 6px of travel before a drag starts; touch: 180ms hold, so a swipe
    // still scrolls the list and the row's own buttons still take clicks.
    expect(source).toContain('useSensor(MouseSensor');
    expect(source).toContain('distance: 6');
    expect(source).toContain('useSensor(TouchSensor');
    expect(source).toContain('delay: 180');
  });
});
