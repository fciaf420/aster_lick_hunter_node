import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ColumnDef } from '@tanstack/react-table';
import { DataTable } from '@/components/data-table/data-table';
import { DataTableColumnHeader } from '@/components/data-table/data-table-column-header';
import { Skeleton } from '@/components/ui/skeleton';

interface Row {
  id: string;
  name: string;
  qty: number;
  pnl: number | undefined;
}

const rows: Row[] = [
  { id: 'a', name: 'Bravo', qty: 5, pnl: 10 },
  { id: 'b', name: 'Alpha', qty: 20, pnl: -5 },
  { id: 'c', name: 'Charlie', qty: 1, pnl: undefined },
  { id: 'd', name: 'Delta', qty: 12, pnl: 30 },
];

const columns: ColumnDef<Row>[] = [
  {
    id: 'name',
    accessorKey: 'name',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
    meta: { label: 'Name column', cellClassName: 'font-medium', skeleton: <Skeleton data-testid="name-skeleton" className="h-4 w-20" /> },
  },
  {
    id: 'qty',
    accessorKey: 'qty',
    header: ({ column }) => <DataTableColumnHeader column={column} title="Qty" align="right" />,
    meta: { headerClassName: 'text-right', cellClassName: 'text-right' },
  },
  {
    id: 'pnl',
    accessorKey: 'pnl',
    header: ({ column }) => <DataTableColumnHeader column={column} title="PnL" align="right" />,
    sortUndefined: 'last',
    cell: ({ row }) => (row.original.pnl === undefined ? '-' : `$${row.original.pnl}`),
  },
  {
    id: 'notes',
    header: 'Notes',
    enableSorting: false,
    cell: () => 'n/a',
  },
];

/** Names in the order the body rows are displayed */
const bodyNames = () =>
  screen
    .getAllByRole('row')
    .slice(1) // header row
    .map((row) => within(row).getAllByRole('cell')[0].textContent);

const header = (name: string) => screen.getByRole('columnheader', { name: new RegExp(name) });
const sortButton = (name: string) => screen.getByRole('button', { name: new RegExp(name) });

describe('DataTable', () => {
  describe('rendering', () => {
    it('renders a header per column and a row per data item in data order', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Name', 'Qty', 'PnL', 'Notes']);
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    });

    it('uses a custom cell renderer and falls back to the raw value', () => {
      render(<DataTable columns={columns} data={rows} />);

      const first = within(screen.getAllByRole('row')[1]).getAllByRole('cell');
      expect(first.map((c) => c.textContent)).toEqual(['Bravo', '5', '$10', 'n/a']);
    });

    it('applies the column meta classes to header and body cells', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(header('Qty')).toHaveClass('text-right');
      expect(within(screen.getAllByRole('row')[1]).getAllByRole('cell')[0]).toHaveClass('font-medium');
    });

    it('applies row classes from a string or a function of the row', () => {
      const { rerender } = render(<DataTable columns={columns} data={rows} rowClassName="h-12" />);
      screen.getAllByRole('row').slice(1).forEach((row) => expect(row).toHaveClass('h-12'));

      rerender(
        <DataTable columns={columns} data={rows} rowClassName={(row) => (row.pnl && row.pnl > 0 ? 'is-winner' : undefined)} />
      );
      const rendered = screen.getAllByRole('row').slice(1);
      expect(rendered.map((row) => row.classList.contains('is-winner'))).toEqual([true, false, false, true]);
    });

    it('applies the header row class', () => {
      render(<DataTable columns={columns} data={rows} headerRowClassName="h-8" />);

      expect(screen.getAllByRole('row')[0]).toHaveClass('h-8');
    });
  });

  describe('empty and loading states', () => {
    it('shows the default empty message in one full-width cell', () => {
      render(<DataTable columns={columns} data={[]} />);

      const cell = screen.getByText('No results.').closest('td');
      expect(cell).toHaveAttribute('colspan', '4');
    });

    it('shows a custom empty state', () => {
      render(<DataTable columns={columns} data={[]} emptyState={<span>No open positions</span>} />);

      expect(screen.getByText('No open positions')).toBeInTheDocument();
      expect(screen.queryByText('No results.')).not.toBeInTheDocument();
    });

    it('renders skeleton rows with the column placeholders instead of data while loading', () => {
      render(<DataTable columns={columns} data={rows} loading loadingRows={2} />);

      expect(screen.queryByText('Bravo')).not.toBeInTheDocument();
      expect(screen.queryByText('No results.')).not.toBeInTheDocument();
      // Header stays visible; each loading row has one cell per column
      expect(screen.getAllByRole('columnheader')).toHaveLength(4);
      const bodyRows = screen.getAllByRole('row').slice(1);
      expect(bodyRows).toHaveLength(2);
      bodyRows.forEach((row) => expect(within(row).getAllByRole('cell')).toHaveLength(4));
      // The column with meta.skeleton uses it, the others get the default placeholder
      expect(screen.getAllByTestId('name-skeleton')).toHaveLength(2);
      expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(8);
    });
  });

  describe('sorting', () => {
    it('keeps the data order until a header is clicked', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
      screen.getAllByRole('columnheader').forEach((h) => {
        if (h.textContent !== 'Notes') expect(h).toHaveAttribute('aria-sort', 'none');
      });
    });

    it('sorts text ascending first and numbers descending first, then flips, then clears', () => {
      render(<DataTable columns={columns} data={rows} />);

      fireEvent.click(sortButton('Name'));
      expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
      expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');

      fireEvent.click(sortButton('Name'));
      expect(bodyNames()).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
      expect(header('Name')).toHaveAttribute('aria-sort', 'descending');

      // Third click clears the sort and restores the original order
      fireEvent.click(sortButton('Name'));
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
      expect(header('Name')).toHaveAttribute('aria-sort', 'none');

      fireEvent.click(sortButton('Qty'));
      expect(bodyNames()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
      expect(header('Qty')).toHaveAttribute('aria-sort', 'descending');
    });

    it('sorts a single column at a time', () => {
      render(<DataTable columns={columns} data={rows} />);

      fireEvent.click(sortButton('Name'));
      fireEvent.click(sortButton('Qty'));

      expect(header('Qty')).toHaveAttribute('aria-sort', 'descending');
      expect(header('Name')).toHaveAttribute('aria-sort', 'none');
    });

    it('does not multi-sort on shift-click', () => {
      render(<DataTable columns={columns} data={rows} />);

      fireEvent.click(sortButton('Name'));
      fireEvent.click(sortButton('Qty'), { shiftKey: true });

      expect(header('Name')).toHaveAttribute('aria-sort', 'none');
      expect(header('Qty')).toHaveAttribute('aria-sort', 'descending');
    });

    it('puts undefined values last in either direction when the column asks for it', () => {
      render(<DataTable columns={columns} data={rows} />);

      fireEvent.click(sortButton('PnL'));
      expect(bodyNames()).toEqual(['Delta', 'Bravo', 'Alpha', 'Charlie']);

      fireEvent.click(sortButton('PnL'));
      expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Delta', 'Charlie']);
    });

    it('does not offer sorting on columns that opt out', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(screen.queryByRole('button', { name: /Notes/ })).not.toBeInTheDocument();
      expect(header('Notes')).not.toHaveAttribute('aria-sort');
    });

    it('applies initialSorting', () => {
      render(<DataTable columns={columns} data={rows} initialSorting={[{ id: 'qty', desc: false }]} />);

      expect(bodyNames()).toEqual(['Charlie', 'Bravo', 'Delta', 'Alpha']);
      expect(header('Qty')).toHaveAttribute('aria-sort', 'ascending');
    });

    it('can start every column descending (sortDescFirst)', () => {
      render(<DataTable columns={columns} data={rows} sortDescFirst />);

      fireEvent.click(sortButton('Name'));
      expect(bodyNames()).toEqual(['Delta', 'Charlie', 'Bravo', 'Alpha']);
      expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
    });

    it('toggles between two directions when sortingRemovable is false', () => {
      render(
        <DataTable
          columns={columns}
          data={rows}
          initialSorting={[{ id: 'qty', desc: true }]}
          sortDescFirst
          sortingRemovable={false}
        />
      );

      expect(bodyNames()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);

      fireEvent.click(sortButton('Qty'));
      expect(header('Qty')).toHaveAttribute('aria-sort', 'ascending');
      expect(bodyNames()).toEqual(['Charlie', 'Bravo', 'Delta', 'Alpha']);

      fireEvent.click(sortButton('Qty'));
      expect(header('Qty')).toHaveAttribute('aria-sort', 'descending');
      expect(bodyNames()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);
    });

    it('keeps the sort when live data changes', () => {
      const { rerender } = render(<DataTable columns={columns} data={rows} getRowId={(row) => row.id} />);
      fireEvent.click(sortButton('Qty'));
      expect(bodyNames()).toEqual(['Alpha', 'Delta', 'Bravo', 'Charlie']);

      rerender(
        <DataTable
          columns={columns}
          getRowId={(row) => row.id}
          data={[...rows.slice(0, 3), { id: 'd', name: 'Delta', qty: 99, pnl: 30 }, { id: 'e', name: 'Echo', qty: 7, pnl: 1 }]}
        />
      );

      expect(header('Qty')).toHaveAttribute('aria-sort', 'descending');
      expect(bodyNames()).toEqual(['Delta', 'Alpha', 'Echo', 'Bravo', 'Charlie']);
    });
  });

  describe('column header', () => {
    const headerWith = (onClick: React.MouseEventHandler<HTMLButtonElement>): ColumnDef<Row>[] => [
      {
        id: 'name',
        accessorKey: 'name',
        header: ({ column }) => <DataTableColumnHeader column={column} title="Name" onClick={onClick} />,
      },
    ];

    it('runs a caller onClick in addition to toggling the sort', () => {
      const onClick = jest.fn();
      render(<DataTable columns={headerWith(onClick)} data={rows} />);

      fireEvent.click(sortButton('Name'));

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
      expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
    });

    it('lets the caller skip the sort toggle with preventDefault', () => {
      const onClick = jest.fn((event: React.MouseEvent) => event.preventDefault());
      render(<DataTable columns={headerWith(onClick)} data={rows} />);

      fireEvent.click(sortButton('Name'));

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(header('Name')).toHaveAttribute('aria-sort', 'none');
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);
    });

    it('passes other button props through', () => {
      const columnsWithProps: ColumnDef<Row>[] = [
        {
          id: 'name',
          accessorKey: 'name',
          header: ({ column }) => <DataTableColumnHeader column={column} title="Name" data-testid="name-sort" />,
        },
      ];
      render(<DataTable columns={columnsWithProps} data={rows} />);

      expect(screen.getByTestId('name-sort')).toBe(sortButton('Name'));
    });
  });

  describe('filter', () => {
    it('is hidden unless a filter column is set', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('filters rows on the chosen column and shows the empty state when nothing matches', () => {
      render(<DataTable columns={columns} data={rows} filterColumn="name" filterPlaceholder="Filter names" />);

      const input = screen.getByRole('textbox', { name: 'Filter names' });
      fireEvent.change(input, { target: { value: 'al' } });
      expect(bodyNames()).toEqual(['Alpha']);

      fireEvent.change(input, { target: { value: 'a' } });
      expect(bodyNames()).toEqual(['Bravo', 'Alpha', 'Charlie', 'Delta']);

      fireEvent.change(input, { target: { value: 'zzz' } });
      expect(screen.getByText('No results.')).toBeInTheDocument();

      fireEvent.change(input, { target: { value: '' } });
      expect(bodyNames()).toHaveLength(4);
    });
  });

  describe('column toggle', () => {
    it('is hidden unless enabled', () => {
      render(<DataTable columns={columns} data={rows} />);

      expect(screen.queryByRole('button', { name: /Columns/ })).not.toBeInTheDocument();
    });

    it('hides and shows columns from the Columns menu, using the meta label when set', async () => {
      render(<DataTable columns={columns} data={rows} columnToggle />);

      // Radix menus open from the keyboard (jsdom has no real pointer events)
      fireEvent.keyDown(screen.getByRole('button', { name: /Columns/ }), { key: 'Enter' });

      // meta.label wins, a string header is used as is, otherwise the column id is shown
      const nameItem = await screen.findByRole('menuitemcheckbox', { name: 'Name column' });
      expect(screen.getByRole('menuitemcheckbox', { name: 'Notes' })).toBeInTheDocument();
      expect(nameItem).toHaveAttribute('aria-checked', 'true');

      // While the menu is open Radix hides the page from the accessibility tree, so read the DOM
      const headerTexts = () => Array.from(document.querySelectorAll('th')).map((th) => th.textContent);
      const firstRowTexts = () =>
        Array.from(document.querySelectorAll('tbody tr:first-child td')).map((td) => td.textContent);

      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'qty' }));
      expect(headerTexts()).toEqual(['Name', 'PnL', 'Notes']);
      expect(firstRowTexts()).toEqual(['Bravo', '$10', 'n/a']);

      // The menu stays open so the column can be turned back on
      fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'qty' }));
      expect(headerTexts()).toEqual(['Name', 'Qty', 'PnL', 'Notes']);
    });
  });

  describe('pagination', () => {
    const many: Row[] = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i + 1}`,
      name: `Row ${String(i + 1).padStart(2, '0')}`,
      qty: i + 1,
      pnl: i,
    }));

    it('shows every row and no pager unless pagination is requested', () => {
      render(<DataTable columns={columns} data={many} />);

      expect(bodyNames()).toHaveLength(25);
      expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();
    });

    it('pages through the rows with the pager buttons', () => {
      render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10 }} />);

      expect(bodyNames()).toHaveLength(10);
      expect(bodyNames()[0]).toBe('Row 01');
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      expect(screen.getByText('25 row(s)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go to previous page' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go to first page' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      expect(bodyNames()[0]).toBe('Row 11');
      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Go to last page' }));
      expect(bodyNames()).toEqual(['Row 21', 'Row 22', 'Row 23', 'Row 24', 'Row 25']);
      expect(screen.getByRole('button', { name: 'Go to next page' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Go to last page' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Go to first page' }));
      expect(bodyNames()[0]).toBe('Row 01');
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Go to previous page' }));
      expect(bodyNames()[0]).toBe('Row 01');
    });

    it('sorts across all pages before cutting the page', () => {
      render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10 }} />);

      fireEvent.click(sortButton('Qty')); // descending first for numbers
      expect(bodyNames()[0]).toBe('Row 25');
      expect(bodyNames()).toHaveLength(10);
    });

    it('lets the user pick the page size when options are given', async () => {
      render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10, pageSizeOptions: [10, 20] }} />);

      fireEvent.click(screen.getByRole('combobox', { name: 'Rows per page' }));
      fireEvent.click(await screen.findByRole('option', { name: '20' }));

      expect(bodyNames()).toHaveLength(20);
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    });

    it('follows a changing pageSize prop and can hide its own pager', () => {
      const { rerender } = render(
        <DataTable columns={columns} data={many} pagination={{ pageSize: 10, controls: false }} />
      );

      expect(bodyNames()).toHaveLength(10);
      expect(screen.queryByText(/Page 1 of/)).not.toBeInTheDocument();

      rerender(<DataTable columns={columns} data={many} pagination={{ pageSize: many.length, controls: false }} />);
      expect(bodyNames()).toHaveLength(25);

      rerender(<DataTable columns={columns} data={many} pagination={{ pageSize: 10, controls: false }} />);
      expect(bodyNames()).toHaveLength(10);
    });

    it('stays on the current page when live data changes and clamps when the data shrinks', () => {
      const { rerender } = render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10 }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

      // A live update that keeps the row count must not jump back to page 1
      rerender(<DataTable columns={columns} data={many.map((r) => ({ ...r, pnl: 1 }))} pagination={{ pageSize: 10 }} />);
      expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();
      expect(bodyNames()[0]).toBe('Row 21');

      // Fewer rows than the current page needs: land on the last page that still exists
      rerender(<DataTable columns={columns} data={many.slice(0, 12)} pagination={{ pageSize: 10 }} />);
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
      expect(bodyNames()).toEqual(['Row 11', 'Row 12']);
    });

    it('returns to the first page when every row disappears, so rows that come back start there', () => {
      const { rerender } = render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10 }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

      rerender(<DataTable columns={columns} data={[]} pagination={{ pageSize: 10 }} />);
      expect(screen.getByText('No results.')).toBeInTheDocument();
      expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
      expect(screen.getByText('0 row(s)')).toBeInTheDocument();

      rerender(<DataTable columns={columns} data={many.slice(0, 12)} pagination={{ pageSize: 10 }} />);
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      expect(bodyNames()[0]).toBe('Row 01');
    });

    it('never commits an empty page while the pager moves back after the rows shrank or came back', () => {
      // Snapshot the committed table body after every commit (Profiler runs once the DOM is updated)
      const commits: string[] = [];
      const record = () => {
        const body = Array.from(document.querySelectorAll('tbody tr')).map((row) => row.textContent);
        commits.push(body.join('|'));
      };
      const table = (data: Row[]) => (
        <React.Profiler id="table" onRender={record}>
          <DataTable columns={columns} data={data} pagination={{ pageSize: 10 }} />
        </React.Profiler>
      );
      const { rerender } = render(table(many));
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));

      // Fewer rows than the current page needs
      commits.length = 0;
      rerender(table(many.slice(0, 12)));
      expect(commits.length).toBeGreaterThan(0);
      commits.forEach((body) => expect(body).not.toContain('No results.'));
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

      // No rows at all, then rows again
      rerender(table([]));
      commits.length = 0;
      rerender(table(many.slice(0, 12)));
      expect(commits.length).toBeGreaterThan(0);
      commits.forEach((body) => expect(body).not.toContain('No results.'));
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
      expect(bodyNames()[0]).toBe('Row 01');
    });

    it('returns to the first page when the filter changes', () => {
      render(<DataTable columns={columns} data={many} pagination={{ pageSize: 10 }} filterColumn="name" />);
      fireEvent.click(screen.getByRole('button', { name: 'Go to next page' }));
      expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Row' } });

      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
      expect(bodyNames()[0]).toBe('Row 01');
    });
  });
});
