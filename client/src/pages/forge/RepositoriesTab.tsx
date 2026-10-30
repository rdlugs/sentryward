import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import { arrayMove, rectSortingStrategy, SortableContext, sortableKeyboardCoordinates } from "@dnd-kit/sortable"
import { CircleAlert, FolderGit2, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { useAuth } from "@/features/auth/useAuth"
import { AddReposSheet } from "@/features/forge/AddReposSheet"
import { FORGE_KIND_OPTIONS, forgeKey } from "@/features/forge/forgeKind"
import { RepoCard } from "@/features/forge/RepoCard"
import {
  byPosition,
  pausedConnections,
  STATUS_OPTIONS,
  useConnectionStatuses,
  useConnections,
  useRemoveRepo,
  useReorderRepos,
  useRepos,
  useSetRepoEnabled,
  type Connection,
  type ConnectionStatus,
  type ForgeRepo,
} from "@/features/forge/api"

const REVIEW_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
]

type ConnectionsById = Record<string, Connection | undefined>

// The repo only knows its provider; the connection says how it was connected.
function repoForgeKey(repo: ForgeRepo, connections: ConnectionsById) {
  const connection = connections[repo.connectionId]
  return connection ? forgeKey(connection) : null
}

function RepoGrid({
  repos,
  statuses,
  reorderable,
}: {
  repos: ForgeRepo[]
  statuses: Record<string, ConnectionStatus | undefined>
  reorderable: boolean
}) {
  const setEnabled = useSetRepoEnabled()
  const reorder = useReorderRepos()
  const [removing, setRemoving] = useState<ForgeRepo | null>(null)
  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so clicking the handle stays a click.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  async function toggle(repo: ForgeRepo, enabled: boolean) {
    try {
      const { webhook } = await setEnabled.mutateAsync({ repo, enabled })
      // Manual reviews still work; say why automatic ones do not.
      if (webhook && !webhook.active) toast.warning(webhook.error ?? "Automatic reviews are unavailable")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the repository")
    }
  }

  // Dragging is only offered on the unfiltered list, so `repos` is the whole
  // order the server stores.
  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return
    const ids = repos.map((repo) => repo.id)
    const moved = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)))
    reorder.mutate(moved, { onError: () => toast.error("Could not save the repository order") })
  }

  return (
    <>
      {repos.length ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={repos.map((repo) => repo.id)} strategy={rectSortingStrategy}>
            <ul aria-label="Repositories" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {repos.map((repo) => (
                <RepoCard
                  key={repo.id}
                  repo={repo}
                  status={statuses[repo.connectionId]}
                  reorderable={reorderable}
                  toggling={setEnabled.isPending && setEnabled.variables?.repo.id === repo.id}
                  onToggle={(enabled) => toggle(repo, enabled)}
                  onRemove={() => setRemoving(repo)}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyDescription>No repositories match your filters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <RemoveRepoDialog repo={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

// Ignores ids that no longer match a connection, e.g. a stale link.
function initialAccount(requested: string | null, connections: Connection[]) {
  if (!requested) return ALL
  return connections.some((connection) => connection.id === requested) ? requested : ALL
}

// The search and filters sit above the grid, so their state lives here and
// the grid only shows what it is given.
function RepoList({
  repos,
  connections,
  onAdd,
}: {
  repos: ForgeRepo[]
  connections: Connection[]
  onAdd: () => void
}) {
  const statuses = useConnectionStatuses(connections)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const [forge, setForge] = useState(ALL)
  const [account, setAccount] = useState(() => initialAccount(params.get("account"), connections))
  const [status, setStatus] = useState(ALL)
  const [reviews, setReviews] = useState(ALL)

  // ?account= is a one-shot preset from the Installation tab's "Manage
  // repositories"; drop it so a reload does not override later filter changes.
  useEffect(() => {
    if (!params.has("account")) return
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete("account")
        return next
      },
      { replace: true },
    )
  }, [params, setParams])
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const filtering = forge !== ALL || account !== ALL || status !== ALL || reviews !== ALL

  function clearFilters() {
    setForge(ALL)
    setAccount(ALL)
    setStatus(ALL)
    setReviews(ALL)
  }

  const connectionsById = useMemo<ConnectionsById>(
    () => Object.fromEntries(connections.map((connection) => [connection.id, connection])),
    [connections],
  )

  const accountOptions = useMemo(
    () =>
      connections
        .map((connection) => ({ value: connection.id, label: `${connection.accountLogin} (${connection.host})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connections],
  )

  const ordered = useMemo(() => [...repos].sort(byPosition), [repos])

  const filtered = useMemo(
    () =>
      ordered.filter(
        (repo) =>
          matchesQuery(query, repo.fullPath, repo.account.login, repo.account.host, repo.defaultBranch) &&
          (forge === ALL || repoForgeKey(repo, connectionsById) === forge) &&
          (account === ALL || repo.connectionId === account) &&
          // Connections still being checked match no specific status.
          (status === ALL || statuses[repo.connectionId] === status) &&
          (reviews === ALL || repo.enabled === (reviews === "enabled")),
      ),
    [ordered, query, forge, account, status, reviews, statuses, connectionsById],
  )

  const activeFilters = [
    { label: "Forge", value: selectedLabel(forge, FORGE_KIND_OPTIONS), onRemove: () => setForge(ALL) },
    { label: "Account", value: selectedLabel(account, accountOptions), onRemove: () => setAccount(ALL) },
    { label: "Connection status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => setStatus(ALL) },
    { label: "Reviews", value: selectedLabel(reviews, REVIEW_OPTIONS), onRemove: () => setReviews(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  // The saved order is the whole list's, so a filtered subset cannot be reordered.
  const narrowed = filtering || query.trim() !== ""
  const reorderable = canManage && repos.length > 1 && !narrowed

  return (
    <>
      <FilterToolbar align="start">
        <SearchInput label="Search repositories" value={query} onChange={setQuery} />
        <FilterPopover active={filtering} onClear={clearFilters} align="start">
          <FilterSelect
            id="repo-forge"
            label="Forge"
            allLabel="All forges"
            value={forge}
            onValueChange={setForge}
            options={FORGE_KIND_OPTIONS}
          />
          {/* With one connection the filter changes nothing, unless it was preset by "Manage repositories". */}
          {(accountOptions.length > 1 || account !== ALL) && (
            <FilterSelect
              id="repo-account"
              label="Account"
              allLabel="All accounts"
              value={account}
              onValueChange={setAccount}
              options={accountOptions}
            />
          )}
          <FilterSelect
            id="repo-status"
            label="Connection status"
            allLabel="All statuses"
            value={status}
            onValueChange={setStatus}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            id="repo-reviews"
            label="Reviews"
            allLabel="All reviews"
            value={reviews}
            onValueChange={setReviews}
            options={REVIEW_OPTIONS}
          />
        </FilterPopover>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add repository
        </Button>
        {/* Last, so applying a filter does not shift the controls. */}
        <ActiveFilterChips filters={activeFilters} />
      </FilterToolbar>
      <PausedAlert connections={pausedConnections(connections, statuses)} />
      {canManage && repos.length > 1 && (
        <p className="text-sm text-muted-foreground">
          {narrowed ? "Clear search and filters to reorder." : "Drag cards by their handle to reorder them."}
        </p>
      )}
      <RepoGrid repos={filtered} statuses={statuses} reorderable={reorderable} />
    </>
  )
}

// Reconnecting the same account replaces the credentials on its connection,
// so unlike removing it, nothing is lost.
function PausedAlert({ connections }: { connections: Connection[] }) {
  if (!connections.length) return null
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>Automatic reviews are paused</AlertTitle>
      <AlertDescription>
        <p>
          The forge rejected the stored credentials for{" "}
          {connections.map((connection, index) => (
            <span key={connection.id}>
              {index > 0 && ", "}
              <span className="font-medium">
                {connection.accountLogin} ({connection.host})
              </span>
            </span>
          ))}
          . Connect the same account again to resume; its repositories and review history are kept.
        </p>
      </AlertDescription>
    </Alert>
  )
}

// Rendered once beside the grid rather than inside a card's menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
function RemoveRepoDialog({ repo, onOpenChange }: { repo: ForgeRepo | null; onOpenChange: (open: boolean) => void }) {
  const remove = useRemoveRepo()

  async function onRemove() {
    if (!repo) return
    try {
      await remove.mutateAsync(repo)
      onOpenChange(false)
      toast.success(`Removed ${repo.fullPath}`)
    } catch {
      toast.error("Could not remove the repository")
    }
  }

  return (
    <Dialog open={repo !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {repo && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {repo.fullPath}?</DialogTitle>
              <DialogDescription>
                Sentryward will stop reviewing it and remove its webhook. Its review history is deleted too. This cannot be
                undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
                {remove.isPending && <Loader2 className="animate-spin" />}
                Remove repository
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RepositoriesTab() {
  const { data, isPending } = useConnections()
  const repos = useRepos()
  const [adding, setAdding] = useState(false)
  const connections = data?.connections ?? []

  const sheet = <AddReposSheet connections={connections} open={adding} onOpenChange={setAdding} />

  if (isPending || (connections.length && repos.isPending)) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-48 rounded-xl" />
        ))}
      </div>
    )
  }

  if (!connections.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>No forge connected</EmptyTitle>
            <EmptyDescription>Connect GitHub or GitLab to choose repositories to review.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/repositories?tab=installation">Connect a forge</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (repos.isError) {
    return (
      <div>
        <p className="text-sm text-destructive">{repos.error.message}</p>
      </div>
    )
  }

  if (!repos.data?.repos.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>No repositories added</EmptyTitle>
            <EmptyDescription>Choose which repositories Sentryward should review.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add repository
            </Button>
          </EmptyContent>
        </Empty>
        {sheet}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <RepoList repos={repos.data.repos} connections={connections} onAdd={() => setAdding(true)} />
      {sheet}
    </div>
  )
}
