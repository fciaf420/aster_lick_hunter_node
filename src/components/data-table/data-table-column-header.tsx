"use client"

import * as React from "react"

import type { Column } from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

interface DataTableColumnHeaderProps<TData, TValue>
  extends Omit<React.ComponentProps<"button">, "title"> {
  column: Column<TData, TValue>
  title: React.ReactNode
  /** Align the title and sort icon with a right-aligned (numeric) column */
  align?: "left" | "right" | "center"
}

/**
 * Column header that toggles sorting when clicked (shadcn Data Table pattern).
 * Renders the plain title for columns that cannot be sorted. The sort state is
 * announced through aria-sort on the enclosing header cell by `DataTable`. A
 * caller's `onClick` runs in addition to the toggle, not instead of it.
 */
function DataTableColumnHeader<TData, TValue>({
  column,
  title,
  align = "left",
  className,
  onClick,
  ...props
}: DataTableColumnHeaderProps<TData, TValue>) {
  if (!column.getCanSort()) {
    return <span className={className}>{title}</span>
  }

  const sorted = column.getIsSorted()
  const Icon =
    sorted === "desc" ? ArrowDown : sorted === "asc" ? ArrowUp : ChevronsUpDown

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-sorted={sorted || undefined}
      className={cn(
        "h-7 gap-1 px-2 font-medium text-inherit",
        align === "left" && "-ml-2",
        align === "right" && "-mr-2",
        align === "center" && "mx-auto",
        className
      )}
      {...props}
      onClick={(event) => {
        // A caller's onClick runs first and can call event.preventDefault() to skip the sort toggle
        onClick?.(event)
        if (!event.defaultPrevented) column.getToggleSortingHandler()?.(event)
      }}
    >
      <span>{title}</span>
      <Icon
        aria-hidden="true"
        className={cn("size-3", !sorted && "text-muted-foreground opacity-60")}
      />
    </Button>
  )
}

export { DataTableColumnHeader }
