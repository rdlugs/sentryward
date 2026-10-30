import { useId } from "react"
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { PAGE_SIZES } from "@/hooks/use-pagination"

// Sits under a table inside its card. `page` is expected to be already
// clamped to the last page (see paginate).
export function TablePagination({
  page,
  size,
  total,
  onPageChange,
  onSizeChange,
}: {
  page: number
  size: number
  total: number
  onPageChange: (page: number) => void
  onSizeChange: (size: number) => void
}) {
  // Unique per instance, so two tables on one page keep their labels apart.
  const sizeId = useId()
  const lastPage = Math.max(1, Math.ceil(total / size))
  const first = (page - 1) * size + 1
  const last = Math.min(page * size, total)

  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-4 border-t pt-4 text-sm text-muted-foreground">
      <p aria-live="polite">{total > 0 && `Showing ${first}-${last} of ${total}`}</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          {/* Reads "Rows" on phones so the controls wrap onto two lines at 320px;
              the select keeps its full name for screen readers. */}
          <Label htmlFor={sizeId} className="font-normal text-muted-foreground">
            {/* One flex item, so the label's gap does not split the words. */}
            <span>
              Rows <span className="sr-only sm:not-sr-only">per page</span>
            </span>
          </Label>
          <Select value={String(size)} onValueChange={(value) => onSizeChange(Number(value))}>
            <SelectTrigger id={sizeId} size="sm" className="w-18">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {PAGE_SIZES.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span>
          Page {page} of {lastPage}
        </span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon-sm" aria-label="First page" disabled={page <= 1} onClick={() => onPageChange(1)}>
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={page >= lastPage}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Last page"
            disabled={page >= lastPage}
            onClick={() => onPageChange(lastPage)}
          >
            <ChevronsRight />
          </Button>
        </div>
      </div>
    </div>
  )
}
