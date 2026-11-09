import {
  Activity,
  BadgePercent,
  Bot,
  BookA,
  Briefcase,
  CircleUserRound,
  Coins,
  CreditCard,
  FileClock,
  FileSearch,
  Files,
  Gauge,
  KeyRound,
  LayoutDashboard,
  ListTree,
  LockKeyhole,
  Mail,
  MailCheck,
  PackageCheck,
  PlugZap,
  ReceiptText,
  RotateCcw,
  Send,
  ShieldCheck,
  Ticket,
  Users,
} from 'lucide-react';
import type { AdminPageDefinition, AdminPageKey, AdminPermissionCodes } from '../app/config';
import { lazy, type ComponentType } from 'react';

/**
 * Each built-in page is a separate chunk loaded on first visit (PageGate renders it inside
 * Suspense), so disabled or unvisited pages never enter the initial bundle.
 */
function lazyPage<M>(load: () => Promise<M>, pick: (module: M) => ComponentType): ComponentType {
  return lazy(async () => ({ default: pick(await load()) }));
}
const AIModelsPage = lazyPage(() => import('./ai-models'), (m) => m.AIModelsPage);
const ConnectionsPage = lazyPage(() => import('./connections'), (m) => m.ConnectionsPage);
const CreditsPage = lazyPage(() => import('./credits'), (m) => m.CreditsPage);
const DashboardPage = lazyPage(() => import('./dashboard'), (m) => m.DashboardPage);
const DictionaryPage = lazyPage(() => import('./dictionary'), (m) => m.DictionaryPage);
const EmailTemplatesPage = lazyPage(() => import('./email'), (m) => m.EmailTemplatesPage);
const EmailLogsPage = lazyPage(() => import('./email'), (m) => m.EmailLogsPage);
const HealthPage = lazyPage(() => import('./health'), (m) => m.HealthPage);
const MenuPage = lazyPage(() => import('./menu'), (m) => m.MenuPage);
const PermissionsPage = lazyPage(() => import('./permissions'), (m) => m.PermissionsPage);
const PlansPage = lazyPage(() => import('./plans'), (m) => m.PlansPage);
const ProfilePage = lazyPage(() => import('./profile'), (m) => m.ProfilePage);
const QuotaUsagePage = lazyPage(() => import('./quota'), (m) => m.QuotaUsagePage);
const QuotaReservationsPage = lazyPage(() => import('./quota'), (m) => m.QuotaReservationsPage);
const AccessLogsPage = lazyPage(() => import('./records'), (m) => m.AccessLogsPage);
const ApiKeysPage = lazyPage(() => import('./records'), (m) => m.ApiKeysPage);
const BillingSubscriptionsPage = lazyPage(() => import('./records'), (m) => m.BillingSubscriptionsPage);
const DeliveriesPage = lazyPage(() => import('./records'), (m) => m.DeliveriesPage);
const FilesPage = lazyPage(() => import('./records'), (m) => m.FilesPage);
const JobsPage = lazyPage(() => import('./records'), (m) => m.JobsPage);
const OperationLogsPage = lazyPage(() => import('./records'), (m) => m.OperationLogsPage);
const OrdersPage = lazyPage(() => import('./records'), (m) => m.OrdersPage);
const RefundsPage = lazyPage(() => import('./refunds'), (m) => m.RefundsPage);
const RolesPage = lazyPage(() => import('./roles'), (m) => m.RolesPage);
const UserSubscriptionsPage = lazyPage(() => import('./subscriptions'), (m) => m.UserSubscriptionsPage);
const UsersPage = lazyPage(() => import('./users'), (m) => m.UsersPage);

type BuiltInPage = AdminPageDefinition & { key: AdminPageKey };

/**
 * Built-in pages. Paths match the server template's starter menu so existing menu records keep
 * working; new back-office pages use the paths documented in the package README.
 */
export function createDefaultPages(codes: AdminPermissionCodes): BuiltInPage[] {
  return [
    { key: 'dashboard', path: '/dashboard', titleKey: 'page.dashboard', permission: codes.dashboard.query, component: DashboardPage, icon: LayoutDashboard, hideInQuickLinks: true },
    { key: 'users', path: '/users', titleKey: 'page.users', permission: codes.users.query, component: UsersPage, icon: Users },
    { key: 'roles', path: '/roles', titleKey: 'page.roles', permission: codes.roles.query, component: RolesPage, icon: ShieldCheck },
    { key: 'permissions', path: '/permissions', titleKey: 'page.permissions', permission: codes.permissions.query, component: PermissionsPage, icon: LockKeyhole },
    { key: 'apiKeys', path: '/records/api-keys', titleKey: 'page.apiKeys', permission: codes.apiKeys.query, component: ApiKeysPage, icon: KeyRound },
    { key: 'plans', path: '/plans', titleKey: 'page.plans', permission: codes.plans.query, component: PlansPage, icon: PackageCheck },
    { key: 'userSubscriptions', path: '/user-subscriptions', titleKey: 'page.userSubscriptions', permission: codes.subscriptions.query, component: UserSubscriptionsPage, icon: Ticket },
    { key: 'quotaUsage', path: '/quota/usage', titleKey: 'page.quotaUsage', permission: codes.quota.query, component: QuotaUsagePage, icon: Gauge },
    { key: 'quotaReservations', path: '/quota/reservations', titleKey: 'page.quotaReservations', permission: codes.quota.query, component: QuotaReservationsPage, icon: BadgePercent },
    { key: 'orders', path: '/records/orders', titleKey: 'page.orders', permission: codes.billing.query, component: OrdersPage, icon: ReceiptText },
    { key: 'billingSubscriptions', path: '/records/subscriptions', titleKey: 'page.billingSubscriptions', permission: codes.billing.query, component: BillingSubscriptionsPage, icon: CreditCard },
    { key: 'refunds', path: '/refunds', titleKey: 'page.refunds', permission: codes.billing.refund, component: RefundsPage, icon: RotateCcw },
    { key: 'credits', path: '/credit', titleKey: 'page.credits', permission: codes.credit.query, component: CreditsPage, icon: Coins },
    { key: 'emailTemplates', path: '/mail/templates', titleKey: 'page.emailTemplates', permission: codes.mail.query, component: EmailTemplatesPage, icon: Mail },
    { key: 'emailLogs', path: '/mail/logs', titleKey: 'page.emailLogs', permission: codes.mail.query, component: EmailLogsPage, icon: MailCheck },
    { key: 'jobs', path: '/records/jobs', titleKey: 'page.jobs', permission: codes.jobs.query, component: JobsPage, icon: Briefcase },
    { key: 'deliveries', path: '/records/deliveries', titleKey: 'page.deliveries', permission: codes.notification.query, component: DeliveriesPage, icon: Send },
    { key: 'files', path: '/records/files', titleKey: 'page.files', permission: codes.files.query, component: FilesPage, icon: Files },
    { key: 'accessLogs', path: '/access-log', titleKey: 'page.accessLogs', permission: codes.logging.query, component: AccessLogsPage, icon: FileSearch },
    { key: 'operationLogs', path: '/records/operation-logs', titleKey: 'page.operationLogs', permission: codes.logging.query, component: OperationLogsPage, icon: FileClock },
    { key: 'health', path: '/system-monitor', titleKey: 'page.health', permission: codes.dashboard.query, component: HealthPage, icon: Activity },
    { key: 'aiModels', path: '/ai-models', titleKey: 'page.aiModels', permission: codes.aiModels.query, component: AIModelsPage, icon: Bot },
    { key: 'connections', path: '/connections', titleKey: 'page.connections', permission: codes.config.query, component: ConnectionsPage, icon: PlugZap },
    { key: 'menu', path: '/menu', titleKey: 'page.menu', permission: codes.menu.query, component: MenuPage, icon: ListTree },
    { key: 'dictionary', path: '/dictionary', titleKey: 'page.dictionary', permission: codes.dictionary.query, component: DictionaryPage, icon: BookA },
    { key: 'profile', path: '/profile', titleKey: 'page.profile', component: ProfilePage, icon: CircleUserRound, hideInQuickLinks: true },
  ];
}
