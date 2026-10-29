import { useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { AlertTriangle, Globe, Plus } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { SearchableSelect, type SelectOptionGroup } from "@/components/SearchableSelect"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { useGlobalConfig } from "@/features/config/api"
import { DEFAULT_CONFIG_TAB, isConfigTab, type ConfigTab } from "@/features/config/tabs"
import { GlobalConfigForm } from "@/features/config/GlobalConfigForm"
import { FollowGlobalSwitch, RepoConfigForm } from "@/features/config/RepoConfigForm"
import { useRepos } from "@/features/forge/api"
import { cn } from "@/lib/utils"

const GLOBAL = "global"

export function ConfigurationPage() {
  const repos = useRepos()
  const global = useGlobalConfig()
  const sorted = useMemo(
    () => [...(repos.data?.repos ?? [])].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [repos.data],
  )

  // ?repo= keeps the selected scope linkable and ?tab= the open tab; without
  // them (or with unknown values) the global config's first tab shows.
  const [params, setParams] = useSearchParams()
  const selected = sorted.find((repo) => repo.id === params.get("repo")) ?? null
  const requestedTab = params.get("tab")
  const tab = isConfigTab(requestedTab) ? requestedTab : DEFAULT_CONFIG_TAB

  const scopeOptions = useMemo<SelectOptionGroup[]>(
    () => [
      { options: [{ value: GLOBAL, label: "All repositories", icon: Globe }] },
      {
        heading: "Repositories",
        options: sorted.map((repo) => ({
          value: repo.id,
          label: repo.fullPath,
          description: repo.account.login,
          keywords: [repo.account.login],
          badge: !repo.followGlobal && Object.keys(repo.settings).length > 0 && (
            <Badge variant="secondary" className="ml-auto">
              Overrides
            </Badge>
          ),
        })),
      },
    ],
    [sorted],
  )

  // Both setters keep the other parameter, so switching scope stays on the same tab.
  function update(next: { repo?: string | null; tab?: string }) {
    const repo = next.repo === undefined ? params.get("repo") : next.repo
    const nextTab = next.tab ?? params.get("tab")
    setParams({ ...(repo ? { repo } : {}), ...(nextTab ? { tab: nextTab } : {}) }, { replace: true })
  }

  const onTabChange = (value: ConfigTab) => update({ tab: value })

  // A scope switch stays on this path, so the forms' route blocker lets it
  // through; it remounts the form, which would drop the edits, so ask here.
  const [dirty, setDirty] = useState(false)
  const [pendingScope, setPendingScope] = useState<string | null>(null)
  function selectScope(value: string) {
    if (value === (selected?.id ?? GLOBAL)) return
    if (dirty) setPendingScope(value)
    else switchScope(value)
  }
  function switchScope(value: string) {
    setDirty(false)
    update({ repo: value === GLOBAL ? null : value })
  }

  let body
  // Wait for the repository list before falling back, so a ?repo= link does not flash the global config.
  if (params.has("repo") && repos.isPending) body = <Skeleton className="h-96 w-full" />
  else if (selected)
    body = (
      <RepoConfigForm key={selected.id} repo={selected} tab={tab} onTabChange={onTabChange} onDirtyChange={setDirty} />
    )
  else if (global.isPending) body = <Skeleton className="h-96 w-full" />
  else if (global.isError)
    body = (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{global.error.message}</AlertTitle>
      </Alert>
    )
  else body = <GlobalConfigForm global={global.data} tab={tab} onTabChange={onTabChange} onDirtyChange={setDirty} />

  return (
    <PageShell className="@container">
      <PageHeader title="Review settings"description="Choose what reviews look for, how they are published and when they block." />
      <div className="flex max-w-5xl flex-col gap-3 rounded-xl border bg-muted/30 p-4 compact:p-3 spacious:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="config-scope">Scope</Label>
          <SearchableSelect
            id="config-scope"
            className="max-w-sm"
            value={selected?.id ?? GLOBAL}
            onValueChange={selectScope}
            searchPlaceholder="Search repositories..."
            emptyText="No matching repositories."
            options={scopeOptions}
          />
          {selected && (
            <div className="flex items-center gap-2">
              <FollowGlobalSwitch repo={selected} id="follow-global" />
              <Label htmlFor="follow-global">Follow global config</Label>
            </div>
          )}
          {repos.isSuccess && sorted.length === 0 && (
            <Button variant="ghost" size="sm" asChild>
              <Link to="/repositories">
                <Plus />
                Add repositories
              </Link>
            </Button>
          )}
          {repos.isError && <p className="text-sm text-destructive">{repos.error.message}</p>}
        </div>
        <p className="text-sm text-muted-foreground">
          {!selected ? (
            <>
              The global config applies to every repository. Repositories that do not follow it layer their own
              overrides on top, and a <code>.sentryward.yaml</code> in a repository still wins over both.
            </>
          ) : selected.followGlobal ? (
            "Only the global config applies. Overrides are kept for when you stop following it."
          ) : (
            <>
              Overrides saved here sit on top of the global config and below a <code>.sentryward.yaml</code> in the
              repository.
            </>
          )}
        </p>
      </div>
      <UnsavedChangesDialog
        open={pendingScope !== null}
        onKeep={() => setPendingScope(null)}
        onDiscard={() => {
          if (pendingScope !== null) switchScope(pendingScope)
          setPendingScope(null)
        }}
      />
      {/* The Display tab splits the full width between its settings and the preview. */}
      <div className={cn("flex flex-col", tab !== "display" && "max-w-5xl")}>{body}</div>
    </PageShell>
  )
}
