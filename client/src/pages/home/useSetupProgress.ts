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
  // Why the action can't be taken yet; shown in its place.
  blocked?: string
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

// The setup steps from live data, in the order a new workspace takes them.
export function useSetupProgress() {
  const connections = useConnections()
  const repos = useRepos()
  const globalConfig = useGlobalConfig()
  const keys = useApiKeys()
  // Same query as the recent reviews timeline, so this adds no request.
  const reviews = useReviews({ limit: 5 })
  // Skipped, failed and cancelled runs are rows too, but none of them shows
  // that reviews work, so only a finished one counts. The recent list covers
  // workspaces whose finished runs are all partial.
  const finished = useReviews({ status: "completed", limit: 1 })

  const keyList = keys.data?.keys ?? []
  const statuses = useApiKeyStatuses(keyList.filter(checkable))
  const statusesPending = keyList.some((key) => checkable(key) && statuses[key.provider] === undefined)

  const isPending =
    connections.isPending ||
    repos.isPending ||
    globalConfig.isPending ||
    keys.isPending ||
    reviews.isPending ||
    finished.isPending ||
    statusesPending

  // A list that failed to load is not evidence that something is missing, so
  // its step counts as done rather than asking for what may already exist.
  const keyStates = keyList.map((key) => keyState(key, statuses[key.provider]))
  const llm: LlmState =
    keys.isError || keyStates.includes("ok") ? "ok" : keyStates.includes("unreachable") ? "unreachable" : "missing"
  const enabledRepos = (repos.data?.repos ?? []).filter((r) => r.enabled).length
  const hasReviews =
    reviews.isError ||
    finished.isError ||
    (finished.data?.total ?? 0) > 0 ||
    (reviews.data?.reviews ?? []).some((r) => r.status === "completed" || r.status === "partial")

  const forgeDone = connections.isError || (connections.data?.connections.length ?? 0) > 0
  const repoDone = repos.isError || enabledRepos > 0
  // An unreachable provider still has a key, so setup is done; Home flags the
  // outage on its own instead of reopening onboarding for it.
  const llmDone = llm !== "missing"

  const steps: SetupStep[] = [
    {
      id: "forge",
      title: "Connect GitHub or GitLab",
      text: "Connect a Git provider so Sentryward can review your pull requests.",
      done: forgeDone,
      action: { label: "Connect a provider", to: "/repositories?tab=installation" },
    },
    {
      id: "repo",
      title: "Enable a repository",
      text: "Pick the repositories whose pull requests should be reviewed.",
      done: repoDone,
      action: { label: "Add repositories", to: "/repositories" },
    },
    {
      id: "llm",
      title: "Connect an LLM provider",
      text: "Sentryward needs a model connection to review pull requests.",
      done: llmDone,
      action: { label: "Add an LLM connection", to: "/llm-connections" },
    },
    {
      id: "review",
      title: "Run a first review",
      text: "Pick an open pull request or paste a link to review it now.",
      done: hasReviews,
      action: { label: "Review a change" },
      // A review needs a repository and a model; without them it can only fail.
      blocked: forgeDone && repoDone && llmDone ? undefined : "Available once the steps above are done.",
    },
  ]

  return {
    isPending,
    steps,
    complete: steps.every((step) => step.done),
    // Repositories can override this, but the global setting is what most of them follow.
    manualOnly: globalConfig.isSuccess && globalConfig.data.config.triggers.review === "manual",
    hasReviews,
    enabledRepos,
    llmUnreachable: llm === "unreachable",
  }
}
