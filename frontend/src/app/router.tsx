import { lazy, Suspense, type ReactNode } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from 'react-router-dom';

import { AppShell } from '../shell/AppShell';

/**
 * Operational shell (Milestone B): one layout, eight tool routes. Chat is the
 * first fully-wired tool; the rest resolve to the honest placeholder until
 * their increments land. The dev harness keeps its own top-level routes.
 */
const AttentionCenter = lazy(() => import('../attention/AttentionCenter'));
const ChatTool = lazy(() => import('../tools/chat/ChatTool'));
const CodeTool = lazy(() => import('../tools/code/CodeTool'));
const ToolPlaceholder = lazy(() => import('../shell/ToolPlaceholder'));

// Code landed first (1.39 A3): it is the surface the attention queue already
// deep-links to, so its items stop landing on a placeholder.
const PLACEHOLDER_TOOLS = ['cowork', 'design', 'playground', 'plugins', 'skills', 'settings'] as const;

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
  { index: true, element: <Navigate to="/chat" replace /> },
  { path: 'attention', ...lazyRoute(<AttentionCenter />) },
  { path: 'chat/*', ...lazyRoute(<ChatTool />) },
  { path: 'code/*', ...lazyRoute(<CodeTool />) },
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
