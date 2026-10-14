import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from 'react-router-dom';

import { AppShell } from '../shell/AppShell';
import { EntryRedirect } from '../shell/EntryRedirect';

/**
 * Operational shell (Milestone B): one layout, eight tool routes. Chat is the
 * first fully-wired tool; the rest resolve to the honest placeholder until
 * their increments land. The dev harness keeps its own top-level routes.
 */
const AttentionCenter = lazy(() => import('../attention/AttentionCenter'));
const ChatTool = lazy(() => import('../tools/chat/ChatTool'));
const CodeTool = lazy(() => import('../tools/code/CodeTool'));
const ToolPlaceholder = lazy(() => import('../shell/ToolPlaceholder'));
const SettingsTool = lazy(() => import('../tools/settings/SettingsTool'));

// Code landed first (1.39 A3): it is the surface the attention queue already
// deep-links to, so its items stop landing on a placeholder.
const PLACEHOLDER_TOOLS = ['cowork', 'design', 'playground', 'plugins', 'skills'] as const;

function RouteFallback({ label }: { label?: string }) {
  return (
    <div className="app-loading" role="status">
      Loading {label ?? 'Hyperion'}…
    </div>
  );
}

function lazyRoute(element: ReactNode): RouteObject {
  return { element: <Suspense fallback={<RouteFallback />}>{element}</Suspense> };
}

const developmentRoutes: RouteObject[] = import.meta.env.DEV
  ? [{ path: '/__dev/states', lazy: () => import('../dev-harness/HarnessRouter') }]
  : [];

const shellChildren: RouteObject[] = [
  // The bare entry restores the last tool the user was in (1.39 A5) and falls back to
  // Chat; the wildcard below stays a fixed answer, because an unknown URL is not a
  // memory to restore.
  { index: true, element: <EntryRedirect /> },
  { path: 'attention', ...lazyRoute(<AttentionCenter />) },
  { path: 'chat/*', ...lazyRoute(<ChatTool />) },
  { path: 'code/*', ...lazyRoute(<CodeTool />) },
  // Settings (Addendum 2.5): Slice 1 makes Providers a real section; the
  // remaining sections land with their own slices and say so in place.
  { path: 'settings/*', ...lazyRoute(<SettingsTool />) },
  ...PLACEHOLDER_TOOLS.map((tool) => ({
    path: `${tool}/*`,
    ...lazyRoute(<ToolPlaceholder />),
  })),
];

export function AppRouter() {
  const router = createBrowserRouter([
    {
      path: '/',
      element: <AppShell />,
      children: shellChildren,
    },
    ...developmentRoutes,
    { path: '*', element: <Navigate to="/chat" replace /> },
  ]);

  return <RouterProvider router={router} />;
}
