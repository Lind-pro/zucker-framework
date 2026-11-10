import { ChevronLeft, ChevronRight, RotateCcw, Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useAdminI18n } from '../i18n/context';
import { cn } from '../lib/cn';
import { displayValue, isAbortError, readPath } from '../lib/format';
import { Button } from './button';
import { EmptyState, ErrorState, LoadingState } from './feedback';
import { Checkbox, Input, Select, type SelectOption } from './inputs';

export interface Column<T> {
  key: string;
  title: ReactNode;
  /** Dotted path used when `render` is absent. */
  field?: string;
  render?: (row: T, index: number) => ReactNode;
  width?: number | string;
  align?: 'left' | 'center' | 'right';
  /** Omitted from the stacked mobile card. */
  hideOnMobile?: boolean;
  className?: string;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number, pageSize: number) => void;
  pageSizeOptions?: readonly number[];
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Accessible table name. */
  label: string;
  loading?: boolean;
  /** A failed read is shown as an error with retry, never as an empty table. */
  error?: boolean | ReactNode;
  onRetry?: () => void;
  emptyText?: ReactNode;
  pagination?: PaginationState;
  selection?: { selected: readonly string[]; onChange: (keys: string[]) => void; isDisabled?: (row: T) => boolean };
  /** Row actions rendered in a trailing column / card footer. */
  actions?: (row: T) => ReactNode;
  onRowClick?: (row: T) => void;
  isRowActive?: (row: T) => boolean;
  minWidth?: number;
  className?: string;
}

function cellValue<T>(column: Column<T>, row: T, index: number): ReactNode {
  if (column.render) return column.render(row, index);
  return displayValue(column.field ? readPath(row, column.field) : undefined);
}

/**
 * Presentational data table. Above md it renders a semantic table; below md each row becomes a
 * card (390px-friendly) with the same content and actions.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  label,
  loading = false,
  error,
  onRetry,
  emptyText,
  pagination,
  selection,
  actions,
  onRowClick,
  isRowActive,
  minWidth,
  className,
}: DataTableProps<T>) {
  const { t } = useAdminI18n();
  const selected = new Set(selection?.selected ?? []);
  // A batch action must only touch rows the operator can see: drop selected keys that left the
  // loaded rows (filter, page or reload changes) instead of keeping them invisibly selected.
  const selectionChange = useRef(selection?.onChange);
  selectionChange.current = selection?.onChange;
  const selectedKeys = selection?.selected;
  useEffect(() => {
    if (!selectedKeys?.length || loading) return;
    const visible = new Set(rows.map(rowKey));
    const kept = selectedKeys.filter((key) => visible.has(key));
    if (kept.length !== selectedKeys.length) selectionChange.current?.(kept);
    // rowKey is a pure accessor; rows identity changes on every load.
  }, [rows, selectedKeys, loading]);
  // Clicking a row is a pointer convenience. Keyboard and screen-reader users get a real, named
  // button (visually hidden until focused) instead of a focusable <tr>/<dl> with no role or name.
  const openButton = (row: T, key: string) =>
    onRowClick ? (
      <button
        type="button"
        className="sr-only focus-visible:not-sr-only focus-visible:mb-1 focus-visible:inline-flex focus-visible:rounded-md focus-visible:px-2 focus-visible:py-1 focus-visible:text-xs focus-visible:outline-2 focus-visible:outline-ring"
        onClick={(event) => {
          event.stopPropagation();
          onRowClick(row);
        }}
      >
        {t('common.openRow', { id: key })}
      </button>
    ) : null;
  const selectable = selection ? rows.filter((row) => !selection.isDisabled?.(row)) : [];
  const allSelected = selectable.length > 0 && selectable.every((row) => selected.has(rowKey(row)));
  const someSelected = selectable.some((row) => selected.has(rowKey(row)));
  const togglePage = (checked: boolean) => {
    const next = new Set(selected);
    for (const row of selectable) {
      if (checked) next.add(rowKey(row));
      else next.delete(rowKey(row));
    }
    selection?.onChange([...next]);
  };
  const toggleRow = (key: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(key);
    else next.delete(key);
    selection?.onChange([...next]);
  };
  const errorState = error ? <ErrorState message={error === true ? undefined : error} onRetry={onRetry} /> : null;
  // A failed reload keeps the rows already shown, with the error above them.
  const body = error && !rows.length ? (
    errorState
  ) : loading && !rows.length ? (
    <LoadingState />
  ) : !rows.length ? (
    <EmptyState>{emptyText}</EmptyState>
  ) : null;
  return (
    <div className={cn('min-w-0 space-y-3', className)} aria-busy={loading || undefined}>
      {body ?? (
        <>
          {errorState}
          <div className="hidden min-w-0 overflow-x-auto rounded-lg border md:block">
            <table aria-label={label} className="w-full caption-bottom text-sm" style={{ minWidth }}>
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  {selection && (
                    <th scope="col" className="w-10 px-3 py-2">
                      <Checkbox
                        aria-label={t('common.selectPage')}
                        checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                        disabled={!selectable.length}
                        onCheckedChange={togglePage}
                      />
                    </th>
                  )}
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className="px-3 py-2 font-medium whitespace-nowrap"
                      style={{ width: column.width, textAlign: column.align }}
                    >
                      {column.title}
                    </th>
                  ))}
                  {actions && (
                    <th scope="col" className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {t('common.actions')}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className={cn(loading && 'opacity-60')}>
                {rows.map((row, index) => {
                  const key = rowKey(row);
                  return (
                    <tr
                      key={key}
                      data-state={selected.has(key) || isRowActive?.(row) ? 'selected' : undefined}
                      className={cn(
                        'border-t align-top transition-colors data-[state=selected]:bg-accent/60',
                        onRowClick && 'cursor-pointer hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      )}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {selection && (
                        <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                          <Checkbox
                            aria-label={t('common.selectRow', { id: key })}
                            checked={selected.has(key)}
                            disabled={selection.isDisabled?.(row)}
                            onCheckedChange={(checked) => toggleRow(key, checked)}
                          />
                        </td>
                      )}
                      {columns.map((column, position) => (
                        <td
                          key={column.key}
                          className={cn('px-3 py-2.5 break-words [overflow-wrap:anywhere]', column.className)}
                          style={{ textAlign: column.align }}
                        >
                          {position === 0 && openButton(row, key)}
                          {cellValue(column, row, index)}
                        </td>
                      ))}
                      {actions && (
                        <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                          <div className="flex flex-wrap items-center justify-end gap-1">{actions(row)}</div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul aria-label={label} className={cn('space-y-3 md:hidden', loading && 'opacity-60')}>
            {rows.map((row, index) => {
              const key = rowKey(row);
              const visible = columns.filter((column) => !column.hideOnMobile);
              return (
                <li
                  key={key}
                  data-state={isRowActive?.(row) ? 'selected' : undefined}
                  className="min-w-0 rounded-xl border bg-card p-4 data-[state=selected]:border-primary"
                >
                  {selection && (
                    <label className="mb-2 flex min-h-11 items-center gap-2 text-sm">
                      <Checkbox
                        checked={selected.has(key)}
                        disabled={selection.isDisabled?.(row)}
                        onCheckedChange={(checked) => toggleRow(key, checked)}
                      />
                      {t('common.selectRow', { id: key })}
                    </label>
                  )}
                  {openButton(row, key)}
                  <dl
                    className={cn('space-y-2', onRowClick && 'cursor-pointer')}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                  >
                    {visible.map((column, position) => (
                      <div key={column.key} className="min-w-0">
                        <dt className="text-xs text-muted-foreground">{column.title}</dt>
                        <dd className={cn('text-sm leading-6 break-words [overflow-wrap:anywhere]', position === 0 && 'font-medium')}>
                          {cellValue(column, row, index)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {actions && <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">{actions(row)}</div>}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {pagination && (!error || rows.length > 0) && <Pagination {...pagination} disabled={loading} />}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  pageSizeOptions = [10, 20, 50, 100],
  disabled,
}: PaginationState & { disabled?: boolean }) {
  const { t } = useAdminI18n();
  const id = useId();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label={t('common.pageStatus', { page, pages, total })} className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span className="text-muted-foreground" aria-live="polite">
        {t('common.pageStatus', { page, pages, total })}
      </span>
      <div className="flex items-center gap-2">
        {pageSizeOptions.length > 1 && (
          <>
            <label htmlFor={id} className="sr-only">
              {t('common.pageSize')}
            </label>
            <Select
              id={id}
              className="h-8 w-auto"
              disabled={disabled}
              value={String(pageSize)}
              options={pageSizeOptions.map((size) => ({ value: String(size), label: String(size) }))}
              onChange={(event) => onChange(1, Number(event.target.value))}
            />
          </>
        )}
        <Button size="icon" aria-label={t('common.previousPage')} disabled={disabled || page <= 1} onClick={() => onChange(page - 1, pageSize)}>
          <ChevronLeft />
        </Button>
        <Button size="icon" aria-label={t('common.nextPage')} disabled={disabled || page >= pages} onClick={() => onChange(page + 1, pageSize)}>
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}

/** Keep a value entered before the options arrived (e.g. typed while a catalog loaded) visible. */
function withCurrent(options: readonly SelectOption[], value: string | undefined): readonly SelectOption[] {
  return value && !options.some((option) => String(option.value) === value) ? [...options, { value, label: value }] : options;
}

export interface FilterSpec {
  name: string;
  label: string;
  type?: 'text' | 'select';
  options?: readonly SelectOption[];
  placeholder?: string;
}
export type FilterValues = Record<string, string>;

/** Search form for list filters; values are applied on submit and cleared by reset. */
export function FilterBar({
  filters,
  values,
  onApply,
}: {
  filters: readonly FilterSpec[];
  values: FilterValues;
  onApply: (values: FilterValues) => void;
}) {
  const { t } = useAdminI18n();
  const prefix = useId();
  const [draft, setDraft] = useState<FilterValues>(values);
  useEffect(() => setDraft(values), [values]);
  if (!filters.length) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply(Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim() !== '').map(([key, value]) => [key, value.trim()])));
  };
  return (
    <form role="search" aria-label={t('common.filters')} onSubmit={submit} className="flex flex-wrap items-end gap-3">
      {filters.map((filter) => {
        const id = `${prefix}-${filter.name}`;
        return (
          <div key={filter.name} className="w-full min-w-0 sm:w-48">
            <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
              {filter.label}
            </label>
            {filter.type === 'select' ? (
              <Select
                id={id}
                name={filter.name}
                value={draft[filter.name] ?? ''}
                placeholder={t('common.all')}
                options={withCurrent(filter.options ?? [], draft[filter.name])}
                onChange={(event) => setDraft({ ...draft, [filter.name]: event.target.value })}
              />
            ) : (
              <Input
                id={id}
                name={filter.name}
                value={draft[filter.name] ?? ''}
                placeholder={filter.placeholder}
                onChange={(event) => setDraft({ ...draft, [filter.name]: event.target.value })}
              />
            )}
          </div>
        );
      })}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" icon={<Search />}>
          {t('common.search')}
        </Button>
        <Button
          icon={<RotateCcw />}
          onClick={() => {
            setDraft({});
            onApply({});
          }}
        >
          {t('common.reset')}
        </Button>
      </div>
    </form>
  );
}

export interface PageQuery {
  page: number;
  pageSize: number;
  filters: FilterValues;
  signal: AbortSignal;
}
export interface PageResult<T> {
  data: T[];
  total: number;
}
export type PageLoader<T> = (query: PageQuery) => Promise<PageResult<T>>;

/** Validate a paginated response instead of rendering an unexpected shape as "no records". */
export function assertPage<T>(value: unknown): PageResult<T> {
  const page = value as Partial<PageResult<T>> | null;
  if (!page || !Array.isArray(page.data) || !Number.isSafeInteger(page.total) || (page.total as number) < 0)
    throw new Error('Unexpected paginated response');
  return { data: page.data, total: page.total as number };
}

export interface ServerTable<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: boolean;
  filters: FilterValues;
  setFilters: (filters: FilterValues) => void;
  setPage: (page: number, pageSize?: number) => void;
  reload: () => void;
  pagination: PaginationState;
}

/**
 * Server-side pagination state. Each load is aborted when superseded or unmounted. A failed reload of
 * the same query keeps the previous rows visible behind an explicit error; a new filter or new `deps`
 * clears them first, so rows of another query are never shown under that error.
 */
export function useServerTable<T>(
  load: PageLoader<T>,
  options: { pageSize?: number; initialFilters?: FilterValues; deps?: readonly unknown[] } = {},
): ServerTable<T> {
  const [page, setPageState] = useState(1);
  const [pageSize, setPageSize] = useState(options.pageSize ?? 20);
  const [filters, setFiltersState] = useState<FilterValues>(options.initialFilters ?? {});
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  const deps = options.deps ?? [];
  // New dependencies (for example another parent record) start again at page 1 in the same render,
  // so no request is made for a page that may not exist in the new result.
  const [previousDeps, setPreviousDeps] = useState<readonly unknown[]>(deps);
  if (previousDeps.length !== deps.length || previousDeps.some((value, index) => !Object.is(value, deps[index]))) {
    setPreviousDeps(deps);
    if (page !== 1) setPageState(1);
    // Rows of the previous parent must not stay actionable if the new query fails.
    setRows([]);
    setTotal(0);
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    loader
      .current({ page, pageSize, filters, signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setRows(result.data);
        setTotal(result.total);
        setError(false);
        // A deletion can leave the current page past the end; move back to the last page.
        const last = Math.max(1, Math.ceil(result.total / pageSize));
        if (page > last) setPageState(last);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted || isAbortError(failure)) return;
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, pageSize, filters, version, ...deps]);
  const setPage = useCallback((next: number, size?: number) => {
    setPageState(next);
    if (size) setPageSize(size);
  }, []);
  const setFilters = useCallback((next: FilterValues) => {
    setFiltersState(next);
    setPageState(1);
    // A different query: drop rows of the old filter so a failure cannot leave them actionable.
    setRows([]);
    setTotal(0);
  }, []);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return {
    rows,
    total,
    page,
    pageSize,
    loading,
    error,
    filters,
    setFilters,
    setPage,
    reload,
    pagination: { page, pageSize, total, onChange: setPage },
  };
}

export interface ResourceTableHandle {
  reload: () => void;
}

export interface ResourceTableProps<T> extends Omit<DataTableProps<T>, 'rows' | 'loading' | 'error' | 'onRetry' | 'pagination'> {
  load: PageLoader<T>;
  filters?: readonly FilterSpec[];
  initialFilters?: FilterValues;
  pageSize?: number;
  /** Page sizes offered to the user; pass a single value when the server uses a fixed page size. */
  pageSizeOptions?: readonly number[];
  /** Toolbar content (create, batch actions) shown above the table. */
  toolbar?: ReactNode;
  /** Re-run the query when any of these change. */
  deps?: readonly unknown[];
  ref?: Ref<ResourceTableHandle>;
  /** Observe each settled load (e.g. to cache rows for parent components). */
  onLoaded?: (rows: T[]) => void;
}

/** Filters + server-paginated table + toolbar, with an imperative `reload()` handle. */
export function ResourceTable<T>({
  load,
  filters = [],
  initialFilters,
  pageSize,
  pageSizeOptions,
  toolbar,
  deps,
  ref,
  onLoaded,
  ...table
}: ResourceTableProps<T>) {
  const state = useServerTable(load, { pageSize, initialFilters, deps });
  useImperativeHandle(ref, () => ({ reload: state.reload }), [state.reload]);
  const loaded = useRef(onLoaded);
  loaded.current = onLoaded;
  useEffect(() => {
    if (!state.loading && !state.error) loaded.current?.(state.rows);
  }, [state.loading, state.error, state.rows]);
  return (
    <div className="min-w-0 space-y-4">
      {(filters.length > 0 || toolbar) && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <FilterBar filters={filters} values={state.filters} onApply={state.setFilters} />
          {toolbar && <div className="ml-auto flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}
      <DataTable
        {...table}
        rows={state.rows}
        loading={state.loading}
        error={state.error}
        onRetry={state.reload}
        pagination={pageSizeOptions ? { ...state.pagination, pageSizeOptions } : state.pagination}
      />
    </div>
  );
}
