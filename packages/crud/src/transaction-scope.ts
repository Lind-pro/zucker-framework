import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseAdapter } from '@zucker-framework/core';

/**
 * Service-level transaction propagation for CrudService.
 *
 * `CrudService.transaction(fn)` binds the transaction adapter of its root DatabaseAdapter in an
 * AsyncLocalStorage. While `fn` runs, every CrudService whose adapter shares that root resolves
 * `db.model()` to the transaction client, so `serviceA.create()` + `serviceB.update()` inside one
 * `transaction()` commit or roll back together.
 *
 * The binding is set ONLY by `CrudService.transaction()`; plain `adapter.$transaction()` calls keep
 * their previous semantics (callers use the adapter passed to their callback).
 */
const storage = new AsyncLocalStorage<ReadonlyMap<DatabaseAdapter, DatabaseAdapter>>();
const ROOT = Symbol.for('zucker.crud.transactionRoot');

type Rooted = DatabaseAdapter & { [ROOT]?: DatabaseAdapter };

/** The adapter that owns transactions for `db` (itself unless `db` is a scoped/derived view). */
export function transactionRoot(db: DatabaseAdapter): DatabaseAdapter {
  return (db as Rooted)[ROOT] ?? db;
}

/** Mark a derived adapter view (e.g. the soft-delete view) as belonging to `base`'s root. */
export function markTransactionRoot<T extends DatabaseAdapter>(view: T, base: DatabaseAdapter): T {
  Object.defineProperty(view, ROOT, { value: transactionRoot(base), enumerable: false });
  return view;
}

/** The transaction adapter bound for `root` by an enclosing `CrudService.transaction()`, if any. */
export function activeTransaction(root: DatabaseAdapter): DatabaseAdapter | undefined {
  return storage.getStore()?.get(root);
}

/**
 * Wrap `db` so `model()` follows the active service transaction. Unknown properties are forwarded
 * to the original adapter so product subclasses keep access to adapter-specific members.
 */
export function transactionScoped(db: DatabaseAdapter): DatabaseAdapter {
  if ((db as Rooted)[ROOT]) return db;
  const root = db;
  return new Proxy(root, {
    get(target, property, receiver) {
      if (property === ROOT) return root;
      if (property === 'model') {
        return (name: string) => (activeTransaction(root) ?? root).model(name);
      }
      if (property === '$transaction') {
        return <R>(fn: (adapter: DatabaseAdapter) => Promise<R>): Promise<R> => {
          const tx = activeTransaction(root);
          return tx ? fn(tx) : root.$transaction(fn);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Run `fn` in a transaction on `db`'s root and bind it for every scoped adapter of that root. */
export async function runInServiceTransaction<R>(
  db: DatabaseAdapter,
  fn: (tx: DatabaseAdapter) => Promise<R>,
): Promise<R> {
  const root = transactionRoot(db);
  const current = activeTransaction(root);
  if (current) return fn(current);
  return root.$transaction((tx) => {
    const bindings = new Map(storage.getStore() ?? []);
    bindings.set(root, tx);
    return storage.run(bindings, () => fn(tx));
  });
}
