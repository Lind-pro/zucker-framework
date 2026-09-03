import React, { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import PageSkeleton from './components/PageSkeleton';

const BasicLayout        = lazy(() => import('./layouts/BasicLayout'));
const Login              = lazy(() => import('./pages/Login'));
const Dashboard          = lazy(() => import('./pages/Dashboard'));
const User               = lazy(() => import('./pages/User'));
const Role               = lazy(() => import('./pages/Role'));
const Permission         = lazy(() => import('./pages/Permission'));
const Dictionary         = lazy(() => import('./pages/Dictionary'));
const Menu               = lazy(() => import('./pages/Menu'));
const Config             = lazy(() => import('./pages/Config'));
const Credit             = lazy(() => import('./pages/Credit'));
const AccessLog          = lazy(() => import('./pages/AccessLog'));
const NotifyTemplate     = lazy(() => import('./pages/Notification/Template'));
const NotifyHistory      = lazy(() => import('./pages/Notification/History'));
const Tenant             = lazy(() => import('./pages/Tenant'));
const I18n               = lazy(() => import('./pages/I18n'));
const FormEngine         = lazy(() => import('./pages/FormEngine'));
const Profile            = lazy(() => import('./pages/Profile'));
const SystemMonitor      = lazy(() => import('./pages/SystemMonitor'));

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
      { path: 'dashboard',             element: renderLazy(Dashboard) },
      { path: 'users',                 element: renderLazy(User) },
      { path: 'roles',                 element: renderLazy(Role) },
      { path: 'permissions',           element: renderLazy(Permission) },
      { path: 'dictionary',            element: renderLazy(Dictionary) },
      { path: 'menu',                  element: renderLazy(Menu) },
      { path: 'config',                element: renderLazy(Config) },
      { path: 'credit',                element: renderLazy(Credit) },
      { path: 'access-log',            element: renderLazy(AccessLog) },
      { path: 'notification/template', element: renderLazy(NotifyTemplate) },
      { path: 'notification/history',  element: renderLazy(NotifyHistory) },
      { path: 'tenant',                element: renderLazy(Tenant) },
      { path: 'i18n',                  element: renderLazy(I18n) },
      { path: 'form-engine',           element: renderLazy(FormEngine) },
      { path: 'profile',               element: renderLazy(Profile) },
      { path: 'system-monitor',        element: renderLazy(SystemMonitor) },
    ],
  },
]);

export default router;
