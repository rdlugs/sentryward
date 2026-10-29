import { useGlobalConfig } from "@/features/config/api"
import { useConnections, useRepos } from "@/features/forge/api"
import { useApiKeyStatuses, useApiKeys, type ApiKey, type LlmConnectionStatus } from "@/features/llm-connections/api"
import { useReviews } from "@/features/reviews/api"

type LlmState = "ok" | "unreachable" | "missing"

export type SetupStepId = "forge" | "repo" | "llm" | "review"

export interface SetupStep {
  id: SetupStepId
  title: string
  text: string
  done: boolean
  // No `to` means the step is acted on in place (the manual review sheet).
  action: { label: string; to?: string }
}

// Whether one provider can serve a review. A stored key wins over the server's
// at review time, so it is judged on its own even when the server has a key.
function keyState(key: ApiKey, status: LlmConnectionStatus | undefined): LlmState {
  if (key.blocked) return "missing"
  if (!key.stored) return key.serverDefault ? "ok" : "missing"
  if (status === "active") return "ok"
  // Revoked, or undecryptable (never checked, so no status): only replacing it helps.
  return status === "unreachable" ? "unreachable" : "missing"
}

// Stored keys the server would actually call: an undecryptable one always
// fails its check, and a blocked one is never called.
function checkable(key: ApiKey) {
  return key.stored && !key.undecryptable && !key.blocked
}

function llmStep(llm: LlmState): SetupStep {
  if (llm === "unreachable") {
    return {
      id: "llm",
      title: "Can't reach your LLM provider",
      text: "The provider didn't answer its status check, so reviews may fail until it's reachable again.",
      done: false,
      action: { label: "Check LLM connections", to: "/llm-connections" },
    }
  }
  return {
    id: "llm",
    title: "Connect an LLM provider",
    text: "Sentryward needs a model connection to review pull requests.",
    done: llm === "ok",
    action: { label: "Add an LLM connection", to: "/llm-connections" },
  }
}

// The setup steps from live data, in the order a new workspace takes them.
export function useSetupProgress() {
  const connections = useConnections()
  const repos = useRepos()
  const globalConfig = useGlobalConfig()
  const keys = useApiKeys()
  // Same query as the recent reviews timeline, so this adds no request.
  const reviews = useReviews({ limit: 5 })

  const keyList = keys.data?.keys ?? []
  const statuses = useApiKeyStatuses(keyList.filter(checkable))
  const statusesPending = keyList.some((key) => checkable(key) && statuses[key.provider] === undefined)

  const isPending = connections.isPending || repos.isPending || keys.isPending || reviews.isPending || statusesPending

  const keyStates = keyList.map((key) => keyState(key, statuses[key.provider]))
  // An unknown key list is not evidence of a missing connection, so the step
  // counts as done rather than asking for one that may already exist.
  const llm: LlmState =
    keys.isError || keyStates.includes("ok") ? "ok" : keyStates.includes("unreachable") ? "unreachable" : "missing"
  // Same reasoning for a review list that failed to load.
  const hasReviews = reviews.isError || (reviews.data?.total ?? 0) > 0

  const steps: SetupStep[] = [
    {
      id: "forge",
      title: "Connect GitHub or GitLab",
      text: "Connect a Git provider so Sentryward can review your pull requests.",
      done: (connections.data?.connections.length ?? 0) > 0,
      action: { label: "Connect a provider", to: "/repositories?tab=installation" },
    },
    {
      id: "repo",
      title: "Enable a repository",
      text: "Pick the repositories whose pull requests should be reviewed.",
      done: (repos.data?.repos ?? []).some((r) => r.enabled),
      action: { label: "Add repositories", to: "/repositories" },
    },
    llmStep(llm),
    {
      id: "review",
      title: "Run a first review",
      text: "Pick an open pull request or paste a link to review it now.",
      done: hasReviews,
      action: { label: "Review a change" },
    },
  ]

  return {
    isPending,
    steps,
    complete: steps.every((step) => step.done),
    // Repositories can override this, but the global setting is what most of them follow.
    manualOnly: globalConfig.data?.config.triggers.review === "manual",
    hasReviews,
  }
}
