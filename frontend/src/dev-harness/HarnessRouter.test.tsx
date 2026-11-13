import{render,screen,within}from'@testing-library/react';
import{MemoryRouter}from'react-router-dom';import userEvent from'@testing-library/user-event';import{describe,expect,it,vi}from'vitest';import{Component}from'./HarnessRouter';
describe('development state harness',()=>{
 // The attention fixture renders the production list, whose rows are real router
 // links, so the harness has to be rendered inside a router as it is in the app.
 const renderHarness=()=>render(<MemoryRouter><Component/></MemoryRouter>);
 it('renders real production state components without network calls',()=>{const fetch=vi.spyOn(globalThis,'fetch');renderHarness();expect(screen.getByRole('heading',{name:'Hyperion state harness'})).toBeInTheDocument();expect(screen.getAllByText('Approval required').length).toBeGreaterThan(0);expect(screen.getByText('Design preview failure')).toBeInTheDocument();expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();});
 it('contains every approved existing-state fixture',()=>{renderHarness();for(const name of['Running','Paused','Approval required','Ready for review','Reconnecting','Stopped','Complete','Error','Interrupted'])expect(screen.getAllByText(name).length).toBeGreaterThan(0);for(const id of['worktree-lane-full','spending-cap-reached','mcp-disconnected','backup-diff','provider-cooldown','design-preview-failure','dangerous-command-confirm'])expect(document.querySelector(`[data-fixture="${id}"]`)).not.toBeNull();});
 it('opens the dangerous-command confirmation with the production dialog',async()=>{renderHarness();await userEvent.click(screen.getByRole('button',{name:'Show confirmation'}));const dialog=screen.getByRole('dialog',{name:'Run this command?'});expect(dialog).toHaveTextContent('rm -rf ./dist && npm run build');expect(within(dialog).getByRole('button',{name:'Allow once'})).toBeInTheDocument();});
 it('renders the whole attention queue fixture from props, with no server',()=>{renderHarness();expect(screen.getByRole('heading',{name:'Attention queue fixture'})).toBeInTheDocument();for(const title of['bash needs a decision','cowork task is blocked','code task has a plan ready','design task was interrupted by a restart','A response is paused','design task is ready for review','failed on its last run','A backup request failed','spending cap is used','is not running'])expect(screen.getAllByText(new RegExp(title)).length).toBeGreaterThan(0);expect(screen.getByText(/the MCP process manager is not managed/)).toBeInTheDocument();});
 it('renders the provenance fixture with a parent chain and an unhashed version',()=>{renderHarness();expect(screen.getByRole('heading',{name:'Provenance fixture'})).toBeInTheDocument();
  // Scoped to the timeline: the section's own note explains what a first version
  // means, and an unscoped text query would count the explanation as a row.
  const timeline=within(screen.getByRole('list',{name:'Version timeline'}));
  expect(timeline.getAllByText(/replaced v2/).length).toBe(1);expect(timeline.getAllByText(/first version/).length).toBe(1);expect(timeline.getAllByText(/not hashed/).length).toBe(1);
  expect(within(screen.getByRole('list',{name:'Knowledge sources used'})).getByText('House style')).toBeInTheDocument();});
 it('renders the Code surface states, including the two a summary gets wrong',()=>{renderHarness();expect(screen.getByRole('heading',{name:'Code surface fixtures'})).toBeInTheDocument();for(const id of['code-lane-busy','code-lane-idle','code-spend-priced','code-spend-floor','code-spend-unpriced','code-spend-unrecorded'])expect(document.querySelector(`[data-fixture="${id}"]`)).not.toBeNull();
  // The lane names its own shape: running slots, an unnamed slot, parked tasks.
  const busy=within(document.querySelector('[data-fixture="code-lane-busy"]') as HTMLElement);
  expect(busy.getByText('2 of 3 lane slots running · 4 queued')).toBeInTheDocument();expect(busy.getByText('A task with no id yet')).toBeInTheDocument();expect(busy.getByText(/holding their worktree/)).toBeInTheDocument();
  // And spend never collapses an absence into a zero.
  expect(within(document.querySelector('[data-fixture="code-spend-unpriced"]') as HTMLElement).getByText(/unpriced — no price row matched/)).toBeInTheDocument();
  expect(within(document.querySelector('[data-fixture="code-spend-unrecorded"]') as HTMLElement).getByText(/nothing was recorded/)).toBeInTheDocument();
  expect(within(document.querySelector('[data-fixture="code-spend-floor"]') as HTMLElement).getByText(/a floor: some requests are unpriced/)).toBeInTheDocument();});
 it('says which states the backend contract does not expose, instead of rendering them as real',()=>{renderHarness();for(const id of['design-preview-failure'])expect(document.querySelector(`[data-fixture="${id}"]`)?.textContent).toMatch(/Not exposed/);});
 it('renders every Preview tab state from the production view, with no network',()=>{const fetch=vi.spyOn(globalThis,'fetch');renderHarness();expect(screen.getByRole('heading',{name:'Preview tab fixtures'})).toBeInTheDocument();
  for(const id of['preview-reading','preview-minting','preview-no-session','preview-disabled','preview-network-error','preview-gone','preview-expired','preview-no-root-html','preview-live'])expect(document.querySelector(`[data-fixture="${id}"]`)).not.toBeNull();
  // The live card carries the exact sandbox, and its text carries no token —
  // the token lives only in the src the frame loads.
  const live=document.querySelector('[data-fixture="preview-live"]') as HTMLElement;
  expect(live.querySelector('iframe')?.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-pointer-lock');
  expect(live.querySelector('iframe')?.getAttribute('referrerpolicy')).toBe('no-referrer');
  expect(live.textContent).not.toContain('a'.repeat(64));
  // Disabled names the setting; expired offers a renewal; the missing root
  // index.html offers the Files tab and mounts no dead frame.
  expect(document.querySelector('[data-fixture="preview-disabled"]')?.textContent).toContain('HYPERION_PREVIEW_PORT');
  expect(document.querySelector('[data-fixture="preview-expired"]')?.textContent).toContain('Renew preview');
  const noRoot=document.querySelector('[data-fixture="preview-no-root-html"]') as HTMLElement;
  expect(noRoot.querySelector('iframe')).toBeNull();
  expect(noRoot.textContent).toContain('Open Files');
  expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();});
  it('renders the Console tab states — bounded, text-only, and honest about an empty frame', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    renderHarness();
    expect(screen.getByRole('heading', { name: 'Console tab fixtures' })).toBeInTheDocument();
    for (const id of [
      'console-empty-no-frame',
      'console-empty-silent',
      'console-log',
      'console-errors',
      'console-overflow',
      'console-hostile',
    ]) {
      expect(document.querySelector(`[data-fixture="${id}"]`)).not.toBeNull();
    }
    const hostile = document.querySelector('[data-fixture="console-hostile"]') as HTMLElement;
    expect(hostile.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(hostile.querySelector('img')).toBeNull();
    const overflow = document.querySelector('[data-fixture="console-overflow"]') as HTMLElement;
    expect(overflow.querySelectorAll('li').length).toBeLessThanOrEqual(100);
    const errors = document.querySelector('[data-fixture="console-errors"]') as HTMLElement;
    expect(errors.querySelector('[data-testid="console-send-errors"]')).not.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});

