import React, { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import PageSkeleton from './components/PageSkeleton';

const BasicLayout = lazy(() => import('./layouts/BasicLayout'));
const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const User = lazy(() => import('./pages/User'));
const Role = lazy(() => import('./pages/Role'));
const Permission = lazy(() => import('./pages/Permission'));
const Dictionary = lazy(() => import('./pages/Dictionary'));
const Menu = lazy(() => import('./pages/Menu'));
const Connections = lazy(() => import('./pages/Connections'));
const Config = lazy(() => import('./pages/Config'));
const Credit = lazy(() => import('./pages/Credit'));
const AccessLog = lazy(() => import('./pages/AccessLog'));
const DisabledFeature = lazy(() => import('./components/DisabledFeature'));
const Content = lazy(() => import('./pages/Content'));
const Categories = lazy(() => import('./pages/Content/Categories'));
const Refunds = lazy(() => import('./pages/Refunds'));
const Records = lazy(() => import('./pages/Records'));
const FormEngine = lazy(() => import('./pages/FormEngine'));
const Profile = lazy(() => import('./pages/Profile'));
const SystemMonitor = lazy(() => import('./pages/SystemMonitor'));

const suspenseFallback = <PageSkeleton />;

const renderLazy = (Component: React.LazyExoticComponent<React.ComponentType>) => (
  <Suspense fallback={suspenseFallback}>
    <Component />
  </Suspense>
);

const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/dashboard" replace />,
  },
  {
    path: '/login',
    element: renderLazy(Login),
  },
  {
    path: '/',
    element: renderLazy(BasicLayout),
    children: [
      { path: 'dashboard', element: renderLazy(Dashboard) },
      { path: 'users', element: renderLazy(User) },
      { path: 'roles', element: renderLazy(Role) },
      { path: 'permissions', element: renderLazy(Permission) },
      { path: 'dictionary', element: renderLazy(Dictionary) },
      { path: 'menu', element: renderLazy(Menu) },
      { path: 'connections', element: renderLazy(Connections) },
      { path: 'config', element: renderLazy(Config) },
      { path: 'credit', element: renderLazy(Credit) },
      { path: 'access-log', element: renderLazy(AccessLog) },
      { path: 'notification/template', element: renderLazy(DisabledFeature) },
      { path: 'notification/history', element: <Navigate to="/records/deliveries" replace /> },
      { path: 'tenant', element: renderLazy(DisabledFeature) },
      { path: 'i18n', element: renderLazy(DisabledFeature) },
      { path: 'form-engine', element: renderLazy(FormEngine) },
      { path: 'profile', element: renderLazy(Profile) },
      { path: 'content', element: renderLazy(Content) },
      { path: 'content/categories', element: renderLazy(Categories) },
      { path: 'refunds', element: renderLazy(Refunds) },
      { path: 'records/:resource', element: renderLazy(Records) },
      { path: 'system-monitor', element: renderLazy(SystemMonitor) },
    ],
  },
]);

export default router;
