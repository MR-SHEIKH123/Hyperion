import { createRef } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentWorkspace } from './AgentWorkspace';
import type { AgentWorkspaceDefinition, AgentWorkspaceHandle, WorkspacePanelId } from './AgentWorkspace.types';

/**
 * The shared frame — the case, not the page.
 *
 * Three tools are mounted in this frame, so what is asserted here is the part a
 * user learns *once*: that each tool's regions land in the same places, that a
 * panel can be folded away and comes back, that the split can be moved by pointer
 * and by keyboard, and that a deep link into a folded panel still arrives where it
 * promised.
 *
 * Two things shape how these are written.
 *
 *   * **Folding means absent, not hidden.** A collapsed region must not keep
 *     focusable content in the tab order or in the accessibility tree, so the
 *     assertion is `queryByText(...) === null`, not a CSS class — a class would
 *     pass with the content still reachable.
 *   * **jsdom has no pointer capture.** The drag path calls
 *     `setPointerCapture`/`releasePointerCapture`, which do not exist there, so
 *     the separator is given recording stubs. Asserting the capture calls is the
 *     point rather than incidental: without capture a fast drag that outruns the
 *     9px handle silently stops resizing, which is the bug the code exists to
 *     avoid.
 */
const fixture = (tool: 'code' | 'design' | 'cowork', full = true): AgentWorkspaceDefinition => ({
  tool,
  taskRail: <p>{tool} tasks</p>,
  ...(full ? { contextExplorer: <p>{tool} context</p> } : {}),
  mainSurface: <p>{tool} main</p>,
  progressStream: <p>{tool} progress</p>,
  ...(full ? { inspector: <p>{tool} inspector</p>, versionTimeline: <p>{tool} versions</p> } : {}),
  composer: <p>{tool} composer</p>,
  statusBanner: <p>{tool} status</p>,
});

/**
 * jsdom does not implement `PointerEvent`.
 *
 * Without it, DOM Testing Library falls back to `new Event('pointerdown', …)`,
 * which keeps only the init fields an `Event` knows — `clientX`, `pointerId` and
 * `button` are dropped on the floor, so a drag test would pass a pointer-down the
 * component correctly ignores. A `MouseEvent` subclass supplies the fields jsdom
 * does have, and adds the one it does not.
 */
class PointerEventLike extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

beforeAll(() => {
  Object.defineProperty(window, 'PointerEvent', { configurable: true, writable: true, value: PointerEventLike });
});

/** The element carrying the frame's geometry, found by the data attributes the CSS reads. */
const column = (): HTMLElement => {
  const node = document.querySelector('[data-left]');
  if (node === null) throw new Error('the workspace column was not rendered');
  return node as HTMLElement;
};

/** A separator with jsdom's missing pointer-capture API recorded rather than thrown at. */
const separator = (name: string) => {
  const node = screen.getByRole('separator', { name });
  const capture = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: vi.fn(() => true),
    releasePointerCapture: vi.fn(),
  };
  Object.assign(node, capture);
  return { node, capture, revalue: () => Number(node.getAttribute('aria-valuenow')) };
};

describe('the shared agent workspace frame', () => {
  it.each(['code', 'design', 'cowork'] as const)('renders %s through the same frame', (tool) => {
    render(<AgentWorkspace definition={fixture(tool)} />);
    expect(screen.getByText(`${tool} main`)).toBeInTheDocument();
    expect(screen.getByLabelText('Main workspace')).toHaveAttribute('data-panel', 'mainSurface');
    // The tool name reaches the DOM as data, so the CSS and any future styling can
    // key on it without the frame knowing what the tool is.
    expect(document.querySelector('[data-tool]')).toHaveAttribute('data-tool', tool);
  });

  it('keeps layout valid when optional panels are omitted', () => {
    render(<AgentWorkspace definition={fixture('code', false)} />);
    expect(screen.queryByLabelText('Inspector')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Main workspace')).toBeInTheDocument();
    // No right-hand panels means no right-hand split to drag, not a handle that
    // moves a column which is not there.
    expect(screen.queryByRole('separator', { name: 'Resize inspector panels' })).not.toBeInTheDocument();
    expect(column()).toHaveAttribute('data-right', 'absent');
  });

  it('exposes stable deep-link focus targets', () => {
    const ref = createRef<AgentWorkspaceHandle>();
    render(<AgentWorkspace ref={ref} definition={fixture('design')} />);
    expect(ref.current?.focusPanel('versionTimeline')).toBe(true);
    expect(screen.getByLabelText('Version timeline')).toHaveFocus();
    expect(ref.current?.focusPanel('inspector')).toBe(true);
  });

  it('answers honestly when asked to focus a panel the occupant never supplied', () => {
    const ref = createRef<AgentWorkspaceHandle>();
    render(<AgentWorkspace ref={ref} definition={fixture('code', false)} />);
    // `false` is the useful answer: a deep link can then fall back to the main
    // surface rather than appearing to work while nothing has focus.
    expect(ref.current?.focusPanel('inspector')).toBe(false);
  });
});

describe('folding a panel', () => {
  it('removes the panel from the document rather than hiding it', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    const region = screen.getByLabelText('Tasks');
    expect(within(region).getByText('code tasks')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide Tasks panel' }));

    // The region survives — it is still the thing a link can point at — but its
    // content is gone from the DOM, so nothing inside it is focusable and no
    // screen reader reaches it.
    expect(screen.getByLabelText('Tasks')).toHaveAttribute('data-folded', 'true');
    expect(within(screen.getByLabelText('Tasks')).queryByText('code tasks')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show Tasks panel' })).toHaveAttribute('aria-expanded', 'false');
    // The control names the region it controls, so the relationship is not conveyed
    // by adjacency alone.
    expect(screen.getByRole('button', { name: 'Show Tasks panel' })).toHaveAttribute('aria-controls', 'region-taskRail');
  });

  it('comes back, and reports what is folded as part of the layout', () => {
    const changed = vi.fn();
    render(<AgentWorkspace definition={fixture('code')} onLayoutChange={changed} />);

    fireEvent.click(screen.getByRole('button', { name: 'Hide Tasks panel' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ collapsed: ['taskRail'] }));

    fireEvent.click(screen.getByRole('button', { name: 'Show Tasks panel' }));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ collapsed: [] }));
    expect(screen.getByText('code tasks')).toBeInTheDocument();
  });

  it('narrows a fully folded column and drops the handle there is nothing to drag', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    expect(separator('Resize navigation panels').revalue()).toBe(280);

    fireEvent.click(screen.getByRole('button', { name: 'Hide Tasks panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide Context explorer panel' }));

    // One panel folded leaves the column wide enough to show the other; both folded
    // leaves a strip of labels, and a separator for that strip would be a control
    // that resizes nothing.
    expect(column()).toHaveAttribute('data-left', 'folded');
    expect(column().style.getPropertyValue('--left-width')).toBe('44px');
    expect(screen.queryByRole('separator', { name: 'Resize navigation panels' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show Tasks panel' }));
    expect(column()).toHaveAttribute('data-left', 'open');
    expect(column().style.getPropertyValue('--left-width')).toBe('280px');
    expect(separator('Resize navigation panels').revalue()).toBe(280);
  });

  it('folds the progress stream without touching the columns beside it', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide Task progress panel' }));
    expect(column()).toHaveAttribute('data-progress', 'folded');
    // The stream lives in the main column, so a folded one must leave both side
    // widths exactly where the user left them.
    expect(column()).toHaveAttribute('data-left', 'open');
    expect(column()).toHaveAttribute('data-right', 'open');
  });

  it('cannot fold the surface, the composer or the status line', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    // A tool is *for* its main surface, the composer is where the next instruction
    // is given, and the status line is the one thing that must not be hideable
    // while a run is parked. None of the three offers a fold control.
    expect(screen.queryByRole('button', { name: /Hide (Main workspace|Task composer|Task status) panel/ })).toBeNull();
    for (const label of ['Main workspace', 'Task composer', 'Task status']) {
      expect(screen.getByLabelText(label)).not.toHaveAttribute('data-folded');
    }
  });

  it('lets an occupant narrow the foldable set, and no more', () => {
    // `collapsible` narrows the default rather than replacing it, so an occupant
    // that forgets the field does not accidentally make the task rail unfoldable.
    render(<AgentWorkspace definition={{ ...fixture('code'), collapsible: ['taskRail'] }} />);
    expect(screen.getByRole('button', { name: 'Hide Tasks panel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Hide Inspector panel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Hide Context explorer panel' })).toBeNull();
  });

  it('ignores a stored fold for a panel that cannot fold, or does not exist', () => {
    // A layout written by a newer build, or by a build where the main surface was
    // foldable, must not be able to fold the surface out of existence here.
    const stored = ['mainSurface', 'notAPanel'] as unknown as WorkspacePanelId[];
    render(<AgentWorkspace definition={fixture('code')} initialLayout={{ collapsed: stored }} />);
    expect(screen.getByText('code main')).toBeInTheDocument();
    expect(screen.getByLabelText('Main workspace')).not.toHaveAttribute('data-folded');
  });

  it('opens a folded panel to honour a deep link into it', () => {
    const ref = createRef<AgentWorkspaceHandle>();
    render(
      <AgentWorkspace
        ref={ref}
        definition={fixture('code')}
        initialLayout={{ collapsed: ['versionTimeline'] }}
      />,
    );
    expect(screen.queryByText('code versions')).not.toBeInTheDocument();

    // Arriving at a panel the user had folded away is the case that made
    // `focusPanel` expand-first: focusing a node that does not exist would either
    // fail silently or, worse, appear to succeed. The handle is called the way a
    // router would call it — imperatively, from outside a render — so the state
    // update it causes has to be flushed before the DOM is read.
    let handled = false;
    act(() => {
      handled = ref.current?.focusPanel('versionTimeline') ?? false;
    });
    expect(handled).toBe(true);
    expect(screen.getByText('code versions')).toBeInTheDocument();
    expect(screen.getByLabelText('Version timeline')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Hide Version timeline panel' })).toBeInTheDocument();
  });
});

describe('resizing the split', () => {
  it('moves by keyboard and reports the layout to be remembered', () => {
    const changed = vi.fn();
    render(<AgentWorkspace definition={fixture('code')} initialLayout={{ leftWidth: 300 }} onLayoutChange={changed} />);
    const left = separator('Resize navigation panels');
    expect(left.node).toHaveAttribute('aria-valuenow', '300');

    fireEvent.keyDown(left.node, { key: 'ArrowRight' });
    expect(left.revalue()).toBe(316);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ leftWidth: 316 }));

    fireEvent.keyDown(left.node, { key: 'ArrowLeft' });
    expect(left.revalue()).toBe(300);
  });

  it('grows the right column leftwards, because its handle is on the outer edge', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    const right = separator('Resize inspector panels');
    expect(right.revalue()).toBe(340);
    fireEvent.keyDown(right.node, { key: 'ArrowLeft' });
    expect(right.revalue()).toBe(356);
  });

  it('clamps at both ends instead of collapsing the surface', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    const left = separator('Resize navigation panels');
    for (let step = 0; step < 12; step++) fireEvent.keyDown(left.node, { key: 'ArrowLeft' });
    expect(left.revalue()).toBe(240);
    for (let step = 0; step < 30; step++) fireEvent.keyDown(left.node, { key: 'ArrowRight' });
    expect(left.revalue()).toBe(520);
  });

  it('clamps a stored width, so a bad saved layout cannot break the frame', () => {
    render(<AgentWorkspace definition={fixture('code')} initialLayout={{ leftWidth: 10, rightWidth: 9_999 }} />);
    expect(separator('Resize navigation panels').revalue()).toBe(240);
    expect(separator('Resize inspector panels').revalue()).toBe(520);
  });

  it('reports a pointer drag once, on release, and keeps the pointer captured meanwhile', () => {
    const changed = vi.fn();
    render(<AgentWorkspace definition={fixture('code')} onLayoutChange={changed} />);
    const left = separator('Resize navigation panels');

    fireEvent.pointerDown(left.node, { button: 0, pointerId: 1, clientX: 400 });
    expect(left.capture.setPointerCapture).toHaveBeenCalledWith(1);
    expect(left.revalue()).toBe(280);

    fireEvent.pointerMove(left.node, { pointerId: 1, clientX: 430 });
    fireEvent.pointerMove(left.node, { pointerId: 1, clientX: 460 });
    // Intermediate pixels are shown but not *reported*: a resize is one decision,
    // and the persistence layer should not be written eighty times for one drag.
    expect(changed).not.toHaveBeenCalled();
    expect(left.revalue()).toBe(340);

    fireEvent.pointerUp(left.node, { pointerId: 1, clientX: 460 });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ leftWidth: 340 }));
    expect(left.capture.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it('ignores a drag that was never started, and a right-hand drag that moves the other way', () => {
    render(<AgentWorkspace definition={fixture('code')} />);
    const right = separator('Resize inspector panels');
    // A move or a release with no pointer-down before it is not a resize: browsers
    // deliver stray moves to hovered elements, and acting on one would move a
    // column the user never grabbed.
    fireEvent.pointerMove(right.node, { pointerId: 2, clientX: 100 });
    fireEvent.pointerUp(right.node, { pointerId: 2, clientX: 100 });
    expect(right.revalue()).toBe(340);

    fireEvent.pointerDown(right.node, { button: 0, pointerId: 3, clientX: 600 });
    fireEvent.pointerMove(right.node, { pointerId: 3, clientX: 500 });
    expect(right.revalue()).toBe(440);
    fireEvent.pointerUp(right.node, { pointerId: 3, clientX: 500 });
    expect(right.revalue()).toBe(440);
  });

  it('still resizes where the environment has no pointer capture at all', () => {
    // Capture is an optimisation, not the mechanism: jsdom has no
    // `setPointerCapture`, and the spec throws `InvalidPointerId` for a pointer
    // that is not active. A resize that throws on pointer-down would take the whole
    // panel with it, so the drag has to work without capture too.
    const changed = vi.fn();
    render(<AgentWorkspace definition={fixture('code')} onLayoutChange={changed} />);
    const node = screen.getByRole('separator', { name: 'Resize navigation panels' });
    expect(typeof (node as { setPointerCapture?: unknown }).setPointerCapture).toBe('undefined');

    fireEvent.pointerDown(node, { button: 0, pointerId: 9, clientX: 400 });
    fireEvent.pointerMove(node, { pointerId: 9, clientX: 428 });
    fireEvent.pointerUp(node, { pointerId: 9, clientX: 428 });
    expect(Number(node.getAttribute('aria-valuenow'))).toBe(308);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('resets to the default width on a double-click', () => {
    const changed = vi.fn();
    render(
      <AgentWorkspace definition={fixture('code')} initialLayout={{ leftWidth: 500, rightWidth: 500 }} onLayoutChange={changed} />,
    );
    fireEvent.doubleClick(separator('Resize navigation panels').node);
    expect(separator('Resize navigation panels').revalue()).toBe(280);
    fireEvent.doubleClick(separator('Resize inspector panels').node);
    expect(separator('Resize inspector panels').revalue()).toBe(340);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
