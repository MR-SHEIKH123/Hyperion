import { describe, expect, it } from 'vitest';
import { AT_BOTTOM_SLACK_PX, anchorForRows, isAtBottom, scrollTopForAnchor, type RowBox } from './scrollAnchor';

const row = (id: string, top: number, height = 100): RowBox => ({ id, top, bottom: top + height });

describe('scroll anchoring', () => {
  it('counts the end of the content as the bottom, with one line of slack', () => {
    expect(isAtBottom({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isAtBottom({ scrollTop: 700 - AT_BOTTOM_SLACK_PX, scrollHeight: 1000, clientHeight: 300 })).toBe(true);
    expect(isAtBottom({ scrollTop: 699 - AT_BOTTOM_SLACK_PX, scrollHeight: 1000, clientHeight: 300 })).toBe(false);
    // Content shorter than the viewport is at the bottom by definition, so an
    // empty transcript follows its own growth instead of looking scrolled up.
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 120, clientHeight: 300 })).toBe(true);
  });

  it('anchors to the topmost row still visible, not to the first one above it', () => {
    const rows = [row('m1', -220), row('m2', -120), row('m3', -20), row('m4', 80)];
    expect(anchorForRows(rows)).toEqual({ anchorId: 'm3', offset: -20 });
  });

  it('has nothing to anchor to when the list is empty or entirely above the fold', () => {
    expect(anchorForRows([])).toBeNull();
    expect(anchorForRows([row('m1', -300), row('m2', -200)])).toBeNull();
  });

  it('moves the remembered row back to the offset it was remembered at', () => {
    // Row m3 was 40px above the viewport's top edge when the reader left.
    const anchor = { anchorId: 'm3', offset: -40 };
    // Reopened at the bottom of a 900px transcript (scrollTop 300), m3 sits 300px
    // above the top edge: the restore scrolls back up to 40, which is where the row
    // is once more 40px above the edge.
    expect(scrollTopForAnchor(anchor, row('m3', -300), 300, 900)).toBe(40);
    // Same anchor, reopened already at the top: nothing needs to move.
    expect(scrollTopForAnchor(anchor, row('m3', -40), 0, 900)).toBe(0);
  });

  it('clamps a restore to the content it has', () => {
    expect(scrollTopForAnchor({ anchorId: 'm1', offset: 0 }, row('m1', 0), 0, 0)).toBe(0);
    expect(scrollTopForAnchor({ anchorId: 'm1', offset: 500 }, row('m1', 0), 0, 600)).toBe(0);
    expect(scrollTopForAnchor({ anchorId: 'm9', offset: -2000 }, row('m9', 0), 0, 600)).toBe(600);
  });
});
