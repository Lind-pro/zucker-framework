/**
 * @zucker-framework/back-office — server hosts of the Framework back office.
 *
 * Each host is a separate subpath so a product loads only what it composes:
 * `/accounts`, `/subscriptions`, `/billing`, `/management`, `/mail`, `/settings`.
 * The root entry exports only the conventions shared by all hosts.
 */
export * from './shared/index';
