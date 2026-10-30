import type { ComponentType, ReactNode, SVGProps } from "react"
import { ListFilter, Search, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { TableCell, TableRow } from "@/components/ui/table"
import { ALL } from "@/lib/filters"
import { cn } from "@/lib/utils"

// Sits above the table card: active filter chips, filter button, then search,
// aligned right.
export function FilterToolbar({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
}

export interface ActiveFilter {
  label: string
  value: string
  onRemove: () => void
}

// Keeps applied filters visible outside the popover, e.g. one preset by a
// link from another page.
export function ActiveFilterChips({ filters }: { filters: ActiveFilter[] }) {
  return filters.map((filter) => (
    // max-w-full and truncate: a long repository path must not widen the page on a phone.
    <Badge key={filter.label} variant="secondary" className="h-7 max-w-full gap-1 pr-1 pl-2.5">
      <span className="truncate" title={`${filter.label}: ${filter.value}`}>
        {filter.label}: <span className="font-normal">{filter.value}</span>
      </span>
      <button
        type="button"
        onClick={filter.onRemove}
        aria-label={`Remove ${filter.label} filter`}
        className="shrink-0 rounded-full p-0.5 hover:bg-foreground/10"
      >
        <X className="size-3" />
      </button>
    </Badge>
  ))
}


export function FilterPopover({
  children,
  active,
  onClear,
}: {
  children: ReactNode
  active: boolean
  onClear: () => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Filters" className="relative shrink-0">
          <ListFilter />
          {active && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" aria-hidden />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-4">
        {children}
        {active && (
          <Button variant="ghost" size="sm" className="self-start" onClick={onClear}>
            <X />
            Clear filters
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

export function SearchInput({
  label,
  value,
  onChange,
  className,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <InputGroup className={cn("w-full sm:w-72", className)}>
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder={`${label}...`}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  )
}

export function FilterSelect({
  id,
  label,
  allLabel,
  value,
  onValueChange,
  options,
}: {
  id: string
  label: string
  allLabel: string
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: string; icon?: ComponentType<SVGProps<SVGSVGElement>> }[]
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-muted-foreground">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper" align="start">
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.icon && <option.icon />}
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function NoMatchesRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-24 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  )
}
