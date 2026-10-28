import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useGlobalConfig } from "@/features/config/api"
import { useConnections, useRepos } from "@/features/forge/api"
import { useApiKeyStatuses, useApiKeys, type ApiKey, type LlmConnectionStatus } from "@/features/llm-connections/api"

interface HeroState {
  title: string
  text: string
  action: { label: string; to: string }
}

// What stands between the user and automatic reviews, earliest missing step first.
function heroState(connections: number, llmUsable: boolean, enabledRepos: number, manualOnly: boolean): HeroState {
  if (connections === 0) {
    return {
      title: "Connect a Git provider",
      text: "Connect GitHub or GitLab so Sentryward can review your pull requests.",
      action: { label: "Connect a provider", to: "/repositories?tab=installation" },
    }
  }
  if (!llmUsable) {
    return {
      title: "Connect an LLM provider",
      text: "Reviews need a working model API key. Add one, or replace a connection that stopped working.",
      action: { label: "Add an LLM connection", to: "/llm-connections" },
    }
  }
  if (enabledRepos === 0) {
    return {
      title: "Reviews are off",
      text: "Enable a repository to start reviewing its pull requests.",
      action: { label: "Add repositories", to: "/repositories" },
    }
  }
  if (manualOnly) {
    return {
      title: "Automatic reviews are off",
      text: "Only reviews you request run: comment /sentryward review on a pull request or start one here.",
      action: { label: "Configure reviews", to: "/configuration" },
    }
  }
  return {
    title: "Reviews are on",
    text: "We'll automatically review PRs in your selected repositories.",
    action: { label: "View repositories", to: "/repositories" },
  }
}

// Whether any model connection can run a review; undefined while that is still
// being checked. A server-wide key counts without a check (the status endpoint
// only covers stored keys); revoked, unreachable and blocked keys do not.
function useLlmUsable(keys: ApiKey[] | undefined): boolean | undefined {
  // An unreadable key has nothing to send the provider, so it is not checked.
  const checked = (keys ?? []).filter((key) => key.stored && !key.undecryptable)
  const statuses: (LlmConnectionStatus | undefined)[] = Object.values(useApiKeyStatuses(checked))

  if (!keys) return undefined
  if (keys.some((key) => key.serverDefault) || statuses.includes("active")) return true
  return statuses.includes(undefined) ? undefined : false
}

export function StatusHero() {
  const connections = useConnections()
  const repos = useRepos()
  const globalConfig = useGlobalConfig()
  const apiKeys = useApiKeys()
  // A failed key listing reads as no keys rather than holding the skeleton forever.
  const llmUsable = useLlmUsable(apiKeys.isError ? [] : apiKeys.data?.keys)

  if (connections.isPending || repos.isPending) return <Skeleton className="h-36 w-full rounded-xl" />
  const connectionCount = connections.data?.connections.length ?? 0
  // Without a forge the LLM step is not shown yet, so its check need not hold the hero.
  if (connectionCount > 0 && llmUsable === undefined) return <Skeleton className="h-36 w-full rounded-xl" />

  const enabledRepos = (repos.data?.repos ?? []).filter((r) => r.enabled).length
  // Repositories can override this, but the global setting is what most of them follow.
  const manualOnly = globalConfig.data?.config.triggers.review === "manual"
  const { title, text, action } = heroState(connectionCount, llmUsable ?? false, enabledRepos, manualOnly)

  return (
    <Card className="bg-gradient-to-br from-muted/70 via-card to-card">
      <CardContent className="flex flex-col items-start gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted-foreground">{text}</p>
        <Button asChild className="mt-2">
          <Link to={action.to}>{action.label}</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
