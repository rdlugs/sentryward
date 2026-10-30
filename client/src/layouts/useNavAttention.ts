import { useConnectionStatuses, useConnections } from "@/features/forge/api"
import { useApiKeys, useApiKeyStatuses } from "@/features/llm-connections/api"
import { needsAttention } from "@/features/llm-connections/health"
import { useReviewAttention } from "@/features/reviews/api"

// What a nav item flags: a count (failed reviews) or a warning dot. The label
// is the screen-reader and tooltip text, so the state never rests on color.
export type NavAttention = { count?: number; label: string }

const EMPTY: never[] = []

// Reads the pages' own status checks from the cache but never starts one: each
// calls the provider or forge, and the sidebar is on every page. Fixing a
// connection there still clears its dot at once. A check not yet run, or still
// running, is not a problem yet; stored flags show without one.
export function useNavAttention(pathname: string): Record<string, NavAttention | undefined> {
  const attention = useReviewAttention()
  const failed = attention.data?.failed ?? 0

  // Only stored keys are checked, as on the LLM Connections page; an
  // unreadable one has nothing to send the provider.
  const keys = (useApiKeys().data?.keys ?? EMPTY).filter((key) => key.stored)
  const keyStatuses = useApiKeyStatuses(
    keys.filter((key) => !key.undecryptable),
    { live: false },
  )
  const llmUnhealthy = keys.some((key) => needsAttention(key, keyStatuses[key.provider]))

  const connections = useConnections().data?.connections ?? EMPTY
  const connectionStatuses = useConnectionStatuses(connections, { live: false })
  const forgeUnhealthy = connections.some((connection) => {
    const status = connectionStatuses[connection.id]
    return status === "revoked" || status === "unreachable"
  })

  return {
    // Not while the list is open (with or without a trailing slash): those
    // runs are on screen.
    "/reviews":
      failed > 0 && pathname.replace(/\/+$/, "") !== "/reviews"
        ? { count: failed, label: `${failed} failed ${failed === 1 ? "review" : "reviews"} since your last visit` }
        : undefined,
    "/llm-connections": llmUnhealthy ? { label: "A connection needs attention" } : undefined,
    "/repositories": forgeUnhealthy ? { label: "A forge connection needs attention" } : undefined,
  }
}
