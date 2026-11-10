import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../test/harness';
import { useState } from 'react';
import { ResourceTable, type PageQuery } from './data-table';
import { FormDialog } from './form';

interface Row {
  id: string;
  name: string;
}
const rows = (page: number, count = 2): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `${page}-${index}`, name: `row ${page}-${index}` }));

afterEach(cleanup);

function setup(load: (query: PageQuery) => Promise<{ data: Row[]; total: number }>) {
  render(
    <ResourceTable<Row>
      label="Records"
      load={load}
      pageSize={2}
      rowKey={(row) => row.id}
      filters={[
        { name: 'name', label: 'Name' },
        { name: 'status', label: 'Status', type: 'select', options: [{ value: 'on', label: 'On' }] },
      ]}
      columns={[{ key: 'name', title: 'Name', field: 'name' }]}
    />,
  );
}

describe('ResourceTable', () => {
  it('requests server pages and moves between them', async () => {
    const load = vi.fn(async ({ page }: PageQuery) => ({ data: rows(page), total: 5 }));
    setup(load);
    const table = await screen.findByRole('table', { name: 'Records' });
    expect(within(table).getByText('row 1-0')).toBeTruthy();
    expect(screen.getAllByText('第 1 / 3 页，共 5 条').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Records' })).getByText('row 2-0')).toBeTruthy());
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2, pageSize: 2, filters: {} }));
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '10' } });
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, pageSize: 10 })));
  });

  it('applies trimmed filters from page 1 and resets them', async () => {
    const load = vi.fn(async ({ page }: PageQuery) => ({ data: rows(page), total: 6 }));
    setup(load);
    await screen.findByRole('table', { name: 'Records' });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  alice ' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'on' } });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, filters: { name: 'alice', status: 'on' } })),
    );
    fireEvent.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, filters: {} })));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  it('shows a read failure with retry instead of an empty table', async () => {
    let fail = true;
    const load = vi.fn(async () => {
      if (fail) throw new Error('down');
      return { data: rows(1), total: 2 };
    });
    setup(load);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('暂无数据')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('table', { name: 'Records' })).toBeTruthy();
  });

  it('shows the empty state for a successful empty page', async () => {
    setup(async () => ({ data: [], total: 0 }));
    expect(await screen.findByText('暂无数据')).toBeTruthy();
  });

  it('aborts the superseded request', async () => {
    const signals: AbortSignal[] = [];
    const load = vi.fn(async ({ page, signal }: PageQuery) => {
      signals.push(signal);
      return { data: rows(page), total: 6 };
    });
    setup(load);
    await screen.findByRole('table', { name: 'Records' });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(signals.length).toBeGreaterThan(1));
    expect(signals[0]!.aborted).toBe(true);
  });
});

function SelectableTable({ load, onRowClick }: { load: (query: PageQuery) => Promise<{ data: Row[]; total: number }>; onRowClick?: (row: Row) => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  return (
    <>
      <output aria-label="selected">{selected.join(',')}</output>
      <ResourceTable<Row>
        label="Records"
        load={load}
        pageSize={2}
        rowKey={(row) => row.id}
        filters={[{ name: 'name', label: 'Name' }]}
        selection={{ selected, onChange: setSelected }}
        onRowClick={onRowClick}
        columns={[{ key: 'name', title: 'Name', field: 'name' }]}
      />
    </>
  );
}

describe('DataTable selection and rows', () => {
  it('drops selected rows that leave the page or filter result', async () => {
    const load = vi.fn(async ({ page }: PageQuery) => ({ data: rows(page), total: 6 }));
    render(<SelectableTable load={load} />);
    const table = await screen.findByRole('table', { name: 'Records' });
    fireEvent.click(within(table).getByRole('checkbox', { name: '选择记录 1-0' }));
    expect(screen.getByLabelText('selected').textContent).toBe('1-0');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Records' })).getByText('row 2-0')).toBeTruthy());
    await waitFor(() => expect(screen.getByLabelText('selected').textContent).toBe(''));
  });

  it('opens clickable rows through a named button and keeps the row click for pointers', async () => {
    const opened = vi.fn();
    render(<SelectableTable load={async () => ({ data: rows(1), total: 2 })} onRowClick={opened} />);
    const table = await screen.findByRole('table', { name: 'Records' });
    const row = within(table).getByText('row 1-0').closest('tr')!;
    expect(row.hasAttribute('tabindex')).toBe(false);
    fireEvent.click(within(row).getByRole('button', { name: '打开记录 1-0' }));
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.click(within(row).getByText('row 1-0'));
    expect(opened).toHaveBeenCalledTimes(2);
    // Controls inside the row do not open it.
    fireEvent.click(within(row).getByRole('checkbox'));
    expect(opened).toHaveBeenCalledTimes(2);
    // The mobile card no longer turns its label/value list into a button.
    expect(document.querySelector('dl[role="button"]')).toBeNull();
  });

  it('keeps loaded rows visible when a reload fails', async () => {
    let fail = false;
    const load = vi.fn(async ({ page }: PageQuery) => {
      if (fail) throw new Error('down');
      return { data: rows(page), total: 6 };
    });
    render(<SelectableTable load={load} />);
    await screen.findByRole('table', { name: 'Records' });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Records' })).getByText('row 1-0')).toBeTruthy();
  });

  it('starts again at page 1 when its dependencies change, without requesting the stale page', async () => {
    const load = vi.fn(async ({ page }: PageQuery) => ({ data: rows(page), total: 6 }));
    function Parent() {
      const [parent, setParent] = useState('a');
      return (
        <>
          <button type="button" onClick={() => setParent('b')}>switch</button>
          <ResourceTable<Row> label="Records" load={load} pageSize={2} deps={[parent]} rowKey={(row) => row.id} columns={[{ key: 'name', title: 'Name', field: 'name' }]} />
        </>
      );
    }
    render(<Parent />);
    await screen.findByRole('table', { name: 'Records' });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() => expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    const before = load.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() => expect(load.mock.calls.length).toBe(before + 1));
    expect(load).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('does not keep the previous parent rows when the load for new dependencies fails', async () => {
    const load = vi.fn(async ({ page }: PageQuery) => {
      if (load.mock.calls.length > 1) throw new Error('down');
      return { data: rows(page), total: 2 };
    });
    function Parent() {
      const [parent, setParent] = useState('a');
      return (
        <>
          <button type="button" onClick={() => setParent('b')}>switch</button>
          <ResourceTable<Row> label="Records" load={load} deps={[parent]} rowKey={(row) => row.id} columns={[{ key: 'name', title: 'Name', field: 'name' }]} />
        </>
      );
    }
    render(<Parent />);
    await screen.findByRole('table', { name: 'Records' });
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('row 1-0')).toBeNull();
  });

  it('offers no page-size selector when only one size is allowed', async () => {
    render(<ResourceTable<Row> label="Records" load={async () => ({ data: rows(1), total: 2 })} pageSize={20} pageSizeOptions={[20]} rowKey={(row) => row.id} columns={[{ key: 'name', title: 'Name', field: 'name' }]} />);
    await screen.findByRole('table', { name: 'Records' });
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('keeps a select filter value that is not among the options visible', async () => {
    render(
      <ResourceTable<Row>
        label="Records"
        load={async () => ({ data: [], total: 0 })}
        rowKey={(row) => row.id}
        initialFilters={{ counter: 'typed_before_catalog' }}
        filters={[{ name: 'counter', label: 'Counter', type: 'select', options: [{ value: 'documents', label: 'Documents' }] }]}
        columns={[{ key: 'name', title: 'Name', field: 'name' }]}
      />,
    );
    await screen.findByText('暂无数据');
    expect((screen.getByLabelText('Counter') as HTMLSelectElement).value).toBe('typed_before_catalog');
  });
});

describe('FormDialog list field', () => {
  it('keeps the typed text while editing and submits the parsed list', async () => {
    const submit = vi.fn();
    render(
      <FormDialog
        open
        onOpenChange={() => undefined}
        title="Menu"
        initialValues={{ permissions: ['a:query'], 'odd"name': '' }}
        fields={[
          { name: 'permissions', label: 'Permissions', type: 'list' },
          { name: 'odd"name', label: 'Odd', required: true },
        ]}
        onSubmit={submit}
      />,
    );
    const input = screen.getByLabelText('Permissions') as HTMLInputElement;
    expect(input.value).toBe('a:query');
    fireEvent.change(input, { target: { value: 'a:query, ' } });
    expect(input.value).toBe('a:query, ');
    fireEvent.change(input, { target: { value: 'a:query, b:update ,' } });
    expect(input.value).toBe('a:query, b:update ,');
    fireEvent.blur(input);
    expect(input.value).toBe('a:query, b:update');
    // An invalid field whose name needs CSS escaping still receives focus.
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/Odd/)));
    fireEvent.change(screen.getByLabelText(/Odd/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith(expect.objectContaining({ permissions: ['a:query', 'b:update'] })));
  });
});
