# Persistent notification inbox

`NotificationInbox<T>` supplies recipient-scoped list/total/unread counts, read-one/read-all and archive behavior through a durable `NotificationInboxRepository<T>`. The repository shape is directly compatible with a Prisma delegate containing id/userId/isRead/readAt/isArchived/createdAt fields. Other stores implement the same contract; database schemas remain consumer-owned.

Every query and mutation carries userId. Missing scope rejects before storage access. Mark-one and archive check ownership and retain userId in the write itself; a Prisma P2025 missing-record race becomes `InboxNotificationNotFoundError`, or the error produced by the consumer's `notFound` callback. Other storage errors propagate. `now` can supply a consistent clock for tests.

Lists and unread badges exclude archived records. Read-all retains the existing contract of updating all recipient unread records, including archived ones. Repeated read-one updates readAt. Pagination accepts positive safe integers, with defaults page 1/pageSize 20; product-specific maximum page size belongs to the caller. Expiry filtering, creation, preferences, types, templates and administrative queries are application policy and are not added by this library.

This API does not register another Nest module/provider or create a new database pool. A configured application service can extend it and retain business methods. Independent source tests cover query scope, stale reads, pagination and persistence failures; no tests or actual database work were executed during this migration.
