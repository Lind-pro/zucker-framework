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
/**
 * A bound transaction. `open` turns false once `root.$transaction` settles, so work started inside
 * the transaction but not awaited (fire-and-forget dispatch, setImmediate) falls back to the root
 * adapter instead of using a closed transaction client.
 */
interface Binding {
  readonly tx: DatabaseAdapter;
  open: boolean;
}

const storage = new AsyncLocalStorage<ReadonlyMap<DatabaseAdapter, Binding>>();
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
  const binding = storage.getStore()?.get(root);
  return binding?.open ? binding.tx : undefined;
}

/**
 * Wrap `db` so `model()` follows the active service transaction. Unknown properties are forwarded
 * to the original adapter so product subclasses keep access to adapter-specific members.
 */
export function transactionScoped(db: DatabaseAdapter): DatabaseAdapter {
  if ((db as Rooted)[ROOT]) return db;
  const root = db;
  return new Proxy(root, {
    get(target, property) {
      if (property === ROOT) return root;
      if (property === 'model') {
        return (name: string) => (activeTransaction(root) ?? root).model(name);
      }
      if (property === '$transaction') {
        return <R>(fn: (adapter: DatabaseAdapter) => Promise<R>, ...rest: unknown[]): Promise<R> => {
          const tx = activeTransaction(root);
          if (tx) return fn(tx);
          // Forward extra arguments (e.g. transaction options) of adapters that accept them.
          return (root.$transaction as (...args: unknown[]) => Promise<R>).call(root, fn, ...rest);
        };
      }
      // Receiver = target: getters of adapters with #private fields throw when `this` is the proxy.
      const value = Reflect.get(target, property, target);
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
  let binding: Binding | undefined;
  try {
    return await root.$transaction((tx) => {
      if (binding) binding.open = false; // an adapter that retries the callback
      binding = { tx, open: true };
      const bindings = new Map(storage.getStore() ?? []);
      bindings.set(root, binding);
      return storage.run(bindings, () => fn(tx));
    });
  } finally {
    if (binding) binding.open = false;
  }
}
