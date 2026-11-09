import { Link } from "react-router"
import { TablePagination } from "@/components/TablePagination"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { costUnknown, formatCost, formatTokens } from "@/features/reviews/cost"
import { changeLabel, untitledChange } from "@/features/reviews/links"
import { usePagination } from "@/hooks/use-pagination"
import { timeAgo } from "@/lib/time"
import { useRecentUsage } from "./api"
import type { UsagePeriod } from "./types"

// ?recentPage= and ?recentSize=, apart from the usage table's.
export const RECENT_PAGINATION = "recent"

// The latest reviews that called a model, in place of a live request feed.
export function RecentReviews({ period }: { period: UsagePeriod }) {
  const pagination = usePagination(RECENT_PAGINATION)
  const { data: page, isPending, isError } = useRecentUsage(period, pagination.page, pagination.size)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent reviews</CardTitle>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : isError ? (
          <p className="py-6 text-center text-sm text-destructive">Could not load recent reviews.</p>
        ) : !page.reviews.length ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No reviews with model usage in this period.</p>
        ) : (
          <ul aria-label="Recent reviews" className="flex flex-col divide-y">
            {page.reviews.map((review) => (
              <li key={review.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 text-sm">
                <div className="flex min-w-0 flex-col">
                  <Link to={`/reviews/${review.id}`} className="truncate font-medium hover:underline">
                    {review.title ?? untitledChange(review.provider, review.number)}
                  </Link>
                  <span className="truncate text-xs text-muted-foreground">
                    {review.fullPath} {changeLabel(review.provider, review.number)} · <span className="font-mono">{review.models.join(", ")}</span>
                  </span>
                </div>
                <div className="flex shrink-0 items-baseline gap-3 text-xs text-muted-foreground tabular-nums">
                  <span>
                    {formatTokens(review.inputTokens)} in · {formatTokens(review.outputTokens)} out
                  </span>
                  <span className="text-foreground">{formatCost(costUnknown(review) ? null : review.usd)}</span>
                  <span>{timeAgo(review.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        {page && page.total > 0 && (
          <TablePagination
            page={page.page}
            size={pagination.size}
            total={page.total}
            onPageChange={pagination.setPage}
            onSizeChange={pagination.setSize}
          />
        )}
      </CardContent>
    </Card>
  )
}
