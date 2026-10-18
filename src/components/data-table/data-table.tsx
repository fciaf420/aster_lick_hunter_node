"use client"

import * as React from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type PaginationState,
  type RowData,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table"

import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { DataTablePagination } from "@/components/data-table/data-table-pagination"
import { DataTableViewOptions } from "@/components/data-table/data-table-view-options"

declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Classes for this column's header cell */
    headerClassName?: string
    /** Classes for this column's body cells */
    cellClassName?: string
    /** Placeholder shown in this column's cells while the table is `loading` */
    skeleton?: React.ReactNode
    /** Name shown in the column toggle menu (defaults to a string header, else the column id) */
    label?: string
  }
}

interface DataTablePaginationOptions {
  /** Rows per page. May change between renders (for example a "show more" button). Default 10 */
  pageSize?: number
  /** Offer a rows-per-page selector with these sizes */
  pageSizeOptions?: number[]
  /** Render the pager below the table. Set to false to paginate from outside. Default true */
  controls?: boolean
}

interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[]
  data: TData[]
  /** Stable row ids keep row state (and React keys) steady while live data updates */
  getRowId?: (row: TData, index: number) => string
  /** Initial sort. Without it rows keep the order of `data` until a header is clicked */
  initialSorting?: SortingState
  /** Sort descending on the first click of every column (TanStack picks per data type by default) */
  sortDescFirst?: boolean
  /** Let a third click on a sorted column clear the sort. Default true */
  sortingRemovable?: boolean
  /** Show a text filter above the table that matches against this column id */
  filterColumn?: string
  filterPlaceholder?: string
  /** Show the "Columns" menu to hide and show columns */
  columnToggle?: boolean
  /** Client-side pagination. Omit to show every row */
  pagination?: DataTablePaginationOptions
  /** Show placeholder rows (using each column's `meta.skeleton`) instead of data */
  loading?: boolean
  loadingRows?: number
  /** Shown in one full-width row when there are no rows to display */
  emptyState?: React.ReactNode
  /** Extra classes for the body rows */
  rowClassName?: string | ((row: TData) => string | undefined)
  /** Extra classes for the header row */
  headerRowClassName?: string
  className?: string
}

const DEFAULT_PAGE_SIZE = 10

/**
 * Reusable shadcn Data Table on top of TanStack Table v8: column definitions,
 * client-side sorting, optional text filter, column visibility menu and
 * pagination. Live data is fine: sorting, filter and page state live in the
 * table and survive `data` updates, and the page index is not reset when
 * rows change (it is clamped if the data shrinks).
 */
function DataTable<TData>({
  columns,
  data,
  getRowId,
  initialSorting,
  sortDescFirst,
  sortingRemovable = true,
  filterColumn,
  filterPlaceholder,
  columnToggle = false,
  pagination,
  loading = false,
  loadingRows = 3,
  emptyState,
  rowClassName,
  headerRowClassName,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting ?? [])
  const [columnFilters, setColumnFilters] = React.useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = React.useState<VisibilityState>({})

  // The pager follows the `pageSize` prop until the user picks another size from the selector
  const propPageSize = pagination?.pageSize ?? DEFAULT_PAGE_SIZE
  const [pageIndex, setPageIndex] = React.useState(0)
  const [chosenPageSize, setChosenPageSize] = React.useState<number | null>(null)
  const pageSize = chosenPageSize ?? propPageSize
  const paginationState: PaginationState = { pageIndex, pageSize }

  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: {
      sorting,
      columnFilters,
      columnVisibility,
      ...(pagination ? { pagination: paginationState } : {}),
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: (updater) => {
      setColumnFilters(updater)
      setPageIndex(0)
    },
    onColumnVisibilityChange: setColumnVisibility,
    onPaginationChange: (updater) => {
      const next = typeof updater === "function" ? updater(paginationState) : updater
      setPageIndex(next.pageIndex)
      setChosenPageSize(next.pageSize === propPageSize ? null : next.pageSize)
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(pagination ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    autoResetPageIndex: false,
    enableMultiSort: false,
    enableSortingRemoval: sortingRemovable,
    sortDescFirst,
  })

  // Rows that vanish (live data, a narrower filter) must not leave the pager on an empty page
  const paginated = Boolean(pagination)
  const pageCount = paginated ? table.getPageCount() : 0
  React.useEffect(() => {
    if (paginated && pageCount > 0 && pageIndex > pageCount - 1) {
      setPageIndex(pageCount - 1)
    }
  }, [paginated, pageCount, pageIndex])

  const visibleColumnCount = table.getVisibleLeafColumns().length
  const rows = table.getRowModel().rows
  const showToolbar = Boolean(filterColumn) || columnToggle
  const filterValue = filterColumn
    ? ((table.getColumn(filterColumn)?.getFilterValue() as string | undefined) ?? "")
    : ""

  return (
    <div data-slot="data-table" className={cn("space-y-3", className)}>
      {showToolbar && (
        <div className="flex items-center gap-2">
          {filterColumn && (
            <Input
              aria-label={filterPlaceholder ?? "Filter rows"}
              placeholder={filterPlaceholder ?? "Filter..."}
              value={filterValue}
              onChange={(event) =>
                table.getColumn(filterColumn)?.setFilterValue(event.target.value)
              }
              className="h-8 max-w-xs"
            />
          )}
          {columnToggle && <DataTableViewOptions table={table} />}
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id} className={headerRowClassName}>
                {headerGroup.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={
                        !header.column.getCanSort()
                          ? undefined
                          : sorted === "asc"
                            ? "ascending"
                            : sorted === "desc"
                              ? "descending"
                              : "none"
                      }
                      className={header.column.columnDef.meta?.headerClassName}
                    >
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: loadingRows }).map((_, index) => (
                <TableRow
                  key={`loading-${index}`}
                  data-slot="data-table-loading-row"
                  className={typeof rowClassName === "string" ? rowClassName : undefined}
                >
                  {table.getVisibleLeafColumns().map((column) => (
                    <TableCell key={column.id} className={column.columnDef.meta?.cellClassName}>
                      {column.columnDef.meta?.skeleton ?? <Skeleton className="h-4 w-full" />}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length > 0 ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={
                    typeof rowClassName === "function" ? rowClassName(row.original) : rowClassName
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.columnDef.meta?.cellClassName}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={visibleColumnCount} className="h-24 text-center">
                  {emptyState ?? <span className="text-muted-foreground">No results.</span>}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {pagination && pagination.controls !== false && (
        <DataTablePagination table={table} pageSizeOptions={pagination.pageSizeOptions} />
      )}
    </div>
  )
}

export { DataTable }
export type { DataTableProps, DataTablePaginationOptions }
