import { Link } from "react-router"
import { ArrowRight } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { useReviews } from "@/features/reviews/api"
import { changeTitle } from "@/features/reviews/links"
import { STATUS_LABEL, VERDICT_LABEL } from "@/features/reviews/options"
import { SideSection } from "./SideSection"

// The latest runs as a timeline: the change, then where it lives and how it went.
export function RecentReviewsTimeline() {
  const { data, isPending } = useReviews({ limit: 5 })

  return (
    <SideSection title="Recent reviews">
      {isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : !data?.reviews.length ? (
        <p className="text-sm text-muted-foreground">No reviews yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col gap-4 border-l pl-4">
            {data.reviews.map((review) => (
              <li key={review.id} className="relative">
                <span className="absolute top-1.5 -left-[1.2rem] size-2 rounded-full bg-muted-foreground/50" aria-hidden />
                <Link
                  to={`/reviews/${review.id}`}
                  className="group inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                >
                  <span className="line-clamp-1">{changeTitle(review)}</span>
                  <ArrowRight className="size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" aria-hidden />
                </Link>
                <p className="truncate text-xs text-muted-foreground">
                  {review.repository.fullPath} · {review.verdict ? VERDICT_LABEL[review.verdict] : STATUS_LABEL[review.status]}
                </p>
              </li>
            ))}
          </ol>
          <Link to="/reviews" className="text-xs text-muted-foreground hover:text-foreground hover:underline">
            View all reviews
          </Link>
        </div>
      )}
    </SideSection>
  )
}
