import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, RouterProvider, type RouteObject } from 'react-router-dom';

const RoutePlaceholder = lazy(() => import('./RoutePlaceholder'));
const toolPaths = ['chat', 'code', 'cowork', 'design', 'playground', 'plugins', 'skills', 'settings'];
const developmentRoutes:RouteObject[]=import.meta.env.DEV?[{path:'/__dev/states',lazy:()=>import('../dev-harness/HarnessRouter')}]:[];
const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/chat" replace /> },
  ...toolPaths.map((path) => ({ path: `/${path}/*`, element: <RoutePlaceholder /> })),
  ...developmentRoutes,
  { path: '*', element: <Navigate to="/chat" replace /> },
]);

export function AppRouter() {
  return <Suspense fallback={<div className="app-loading" role="status">Loading Hyperion…</div>}><RouterProvider router={router} /></Suspense>;
}
