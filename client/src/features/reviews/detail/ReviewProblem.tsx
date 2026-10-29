import { Link } from "react-router"
import { ArrowRight, Loader2, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { ReviewDetail, ReviewErrorKind } from "../types"

// Where each kind of error is fixed. The trigger link opens the repository's
// own scope, since that is where its overrides (if any) live.
function fixFor(kind: ReviewErrorKind, review: ReviewDetail): { label: string; to: string } {
  switch (kind) {
    case "llm_connection":
      return { label: "Check LLM connections", to: "/llm-connections" }
    case "llm_config":
      return { label: "Choose an LLM connection", to: "/configuration?tab=llm" }
    case "forge_credentials":
      return { label: "Reconnect the account", to: "/repositories?tab=installation" }
    case "forge_access":
      return { label: "Check the installation", to: "/repositories?tab=installation" }
    case "repo_disabled":
      return { label: "Turn reviews back on", to: "/repositories" }
    case "privacy":
      return { label: "Review the privacy policy", to: "/privacy" }
    case "trigger":
      return { label: "Change trigger settings", to: `/configuration?repo=${review.repository.id}&tab=triggers` }
  }
}

// A trigger the repository file set cannot be changed from the dashboard.
function triggerFromFile(review: ReviewDetail) {
  const sources = review.resolvedConfig?.sources ?? {}
  return Object.entries(sources).some(([path, source]) => path.startsWith("triggers.") && source === "repoFile")
}

// The next steps for a review that did not succeed: run it again, and open the
// page that fixes the cause when the server recognised it.
export function ReviewProblemActions(props: { review: ReviewDetail; onRerun: () => void; rerunning: boolean }) {
  const { review } = props
  // A repository with reviews turned off (by hand or after losing access)
  // refuses a re-run until it is back on, whatever error this run stored.
  const canRerun =
    (review.status === "failed" || review.status === "cancelled" || review.status === "skipped") &&
    review.repository.enabled
  // Once the repository is back on, there is nothing left to turn on.
  const stale = review.errorKind === "repo_disabled" && review.repository.enabled
  const fix = review.errorKind && !stale && fixFor(review.errorKind, review)
  if (!canRerun && !fix) return null
  return (
    <div className="flex flex-col gap-2 pt-1">
      {review.errorKind === "trigger" && (
        <p>
          {triggerFromFile(review)
            ? `The repository's ${review.resolvedConfig?.repoFile ?? ".sentryward.yaml"} sets some of its trigger settings, and those win over the dashboard.`
            : "A trigger setting kept this run from starting. A manual review or re-run is never skipped this way."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canRerun && (
          <Button size="sm" variant="outline" onClick={props.onRerun} disabled={props.rerunning}>
            {props.rerunning ? <Loader2 className="animate-spin" /> : <RotateCw />}
            Re-run
          </Button>
        )}
        {fix && (
          <Button size="sm" variant="outline" asChild>
            <Link to={fix.to}>
              {fix.label}
              <ArrowRight />
            </Link>
          </Button>
        )}
      </div>
    </div>
  )
}
