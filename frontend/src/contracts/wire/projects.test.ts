import { describe,expect,it } from 'vitest';
import { openedProjectResponseSchema,projectResponseSchema,projectsResponseSchema,projectTasksResponseSchema } from './projects';
/**
 * The shapes the routes actually return (`docs/API.md` §15), parsed here rather
 * than trusted.
 *
 * `projects.active-tasks` is `partial` in the ledger because no surface calls it
 * yet — but "no caller" is not "no contract", and the one thing this file is for
 * is the class of bug that hid in this module until 2026-09-22: `projectSchema`
 * required an `updatedAt` the backend has never sent, which nothing could have
 * noticed while no caller existed. A fixture copied from the route's own response
 * is what makes a wrong field a failing test instead of an `invalid_response` at
 * runtime.
 */
const project={ id:'8f3c', name:'Hyperion', path:'/home/me/Hyperion', managed:false, createdAt:1765000000000, lastOpenedAt:1765100000000 };
const unopened={ id:'a1b2', name:'Fresh', path:'/home/me/Hyperion/projects/Fresh', managed:true, createdAt:1765200000000, lastOpenedAt:null };
describe('projects wire contract',()=>{
 it('accepts the registry response, opened and never-opened projects alike',()=>{
  const parsed=projectsResponseSchema.safeParse({ projects:[project,unopened], activeId:'8f3c', activeRoot:'/home/me/Hyperion', defaultRoot:'/home/me/Hyperion/projects' });
  expect(parsed.success).toBe(true);
 });
 it('accepts an empty registry with nothing open',()=>{
  expect(projectsResponseSchema.safeParse({ projects:[], activeId:null, activeRoot:'/home/me/Hyperion/projects', defaultRoot:'/home/me/Hyperion/projects' }).success).toBe(true);
 });
 it('does not require an updatedAt the backend never sends',()=>{
  // The field that made every project response unparseable until 2026-09-22.
  expect('updatedAt' in project).toBe(false);
  expect(projectResponseSchema.safeParse({ project }).success).toBe(true);
  expect(openedProjectResponseSchema.safeParse({ project, activeRoot:'/home/me/Hyperion' }).success).toBe(true);
 });
 it('refuses a project without its identity',()=>{
  expect(projectResponseSchema.safeParse({ project:{ ...project, id:undefined } }).success).toBe(false);
 });
});
describe('the per-project task listing wire contract',()=>{
 const listing={ project, active:true,
  tasks:[{ tool:'code', taskId:'t-1', runId:'r-1', state:'blocked', pauseReason:'approval_required', chatId:null, startedAt:1765200000000, updatedAt:1765200300000 }],
  counts:{ total:1, running:0, paused:0, blocked:1, ready_for_review:0 },
  unattributedActive:2 };
 it('accepts the listing and its per-state counts',()=>{
  const parsed=projectTasksResponseSchema.safeParse(listing);
  expect(parsed.success).toBe(true);
  expect(parsed.data?.tasks[0]?.state).toBe('blocked');
 });
 it('requires the unattributed count rather than defaulting it to zero',()=>{
  const without:Record<string,unknown>={ ...listing };
  delete without.unattributedActive;
  // Omission must fail: a client that rendered `tasks` alone while runs with no
  // project are live would be presenting a partial answer as the whole one.
  expect(projectTasksResponseSchema.safeParse(without).success).toBe(false);
  expect(projectTasksResponseSchema.safeParse({ ...listing, unattributedActive:0 }).success).toBe(true);
 });
 it('carries every count key even at zero',()=>{
  const counts:Record<string,unknown>={ ...listing.counts };
  delete counts.ready_for_review;
  expect(projectTasksResponseSchema.safeParse({ ...listing, counts }).success).toBe(false);
 });
 it('refuses a run state the backend does not send',()=>{
  const tasks=[{ ...listing.tasks[0], state:'cancelled' }];
  expect(projectTasksResponseSchema.safeParse({ ...listing, tasks }).success).toBe(false);
 });
 it('refuses a tool this frontend does not know',()=>{
  const tasks=[{ ...listing.tasks[0], tool:'playground' }];
  expect(projectTasksResponseSchema.safeParse({ ...listing, tasks }).success).toBe(false);
 });
});
