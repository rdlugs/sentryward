import { useEffect, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useSearchParams } from "react-router"
import { Loader2, Plug, Plus } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { SearchableSelect } from "@/components/SearchableSelect"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import {
  STATUS_OPTIONS,
  useConnectionStatuses,
  useConnectToken,
  useConnections,
  useDeleteConnection,
  useReorderConnections,
  type Connection,
  type ConnectionStatus,
  type TokenConnectInput,
} from "@/features/forge/api"
import { FORGE_KIND_OPTIONS, forgeKey } from "@/features/forge/forgeKind"
import { ConnectionCard } from "@/features/forge/ConnectionCard"
import { ConnectionDetailsSheet } from "@/features/forge/ConnectionDetailsSheet"
import { SortableGrid } from "@/features/forge/SortableGrid"
import { isProvider, offersOAuth, PROVIDER_IDS, PROVIDERS, type TokenMethod } from "@/features/forge/providers"
import type { Provider } from "@/features/reviews/types"
import { ApiError, apiWorkspace } from "@/lib/api"

// The install (or OAuth sign-in) starts with a browser navigation, which cannot carry the
// workspace header, so a team workspace goes in the query instead.
function installHref(href: string) {
  const workspace = apiWorkspace()
  return workspace ? `${href}?${new URLSearchParams({ workspace })}` : href
}

function tokenSchema(method: TokenMethod) {
  const shape: Record<string, z.ZodString> = {
    host: method.fixedHost ? z.string().trim() : z.string().trim().min(1, "Host is required"),
    token: z.string().trim().min(1, "Token is required"),
  }
  for (const field of method.extraFields ?? []) {
    shape[field.name] = z.string().trim().min(1, `${field.label} is required`)
  }
  return z.object(shape)
}

const RETURN_MESSAGES: Record<string, string> = {
  github_install_failed: "GitHub installation could not be completed",
  github_install_forbidden: "That GitHub installation is not one your account can access",
  github_pending_approval: "The installation is waiting for an organization owner to approve it",
  gitlab_oauth_failed: "GitLab sign-in could not be completed",
  gitlab_oauth_denied: "GitLab sign-in was cancelled",
}

// GitHub and GitLab send the browser back here with ?connected= or ?error=.
function useReturnToast() {
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const connected = params.get("connected")
    const error = params.get("error")
    if (!connected && !error) return
    if (connected) toast.success(`${isProvider(connected) ? PROVIDERS[connected].label : "Account"} connected`)
    if (error) toast.error(RETURN_MESSAGES[error] ?? "Connection failed")
    // Drop only the return markers so ?tab= survives.
    const next = new URLSearchParams(params)
    next.delete("connected")
    next.delete("error")
    setParams(next, { replace: true })
  }, [params, setParams])
}

function TokenForm({
  provider,
  method,
  initialHost,
  onConnected,
}: {
  provider: Provider
  method: TokenMethod
  initialHost?: string
  onConnected?: () => void
}) {
  const connect = useConnectToken(provider)
  const label = PROVIDERS[provider].label
  const extraFields = method.extraFields ?? []
  const form = useForm<TokenConnectInput>({
    resolver: zodResolver(tokenSchema(method)),
    defaultValues: {
      host: method.fixedHost ?? initialHost ?? "",
      token: "",
      ...Object.fromEntries(extraFields.map((field) => [field.name, ""])),
    },
  })

  async function onSubmit(values: TokenConnectInput) {
    try {
      const { connection } = await connect.mutateAsync(values)
      toast.success(`Connected ${label} as ${connection.accountLogin}`)
      form.reset({ ...values, token: "" })
      onConnected?.()
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {!method.fixedHost && (
          <TextField control={form.control} name="host" label="Host" placeholder={method.hostPlaceholder} />
        )}
        {extraFields.map((field) => (
          <TextField
            key={field.name}
            control={form.control}
            name={field.name}
            label={field.label}
            type={field.type ?? "text"}
            autoComplete="off"
            placeholder={field.placeholder}
          />
        ))}
        <TextField
          control={form.control}
          name="token"
          label="Access token"
          type="password"
          autoComplete="off"
          placeholder={method.tokenPlaceholder}
        />
        <Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Connect {label}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

function ConnectionGrid({
  connections,
  statuses,
  reorderable,
  onReconnect,
}: {
  connections: Connection[]
  statuses: Record<string, ConnectionStatus | undefined>
  reorderable: boolean
  onReconnect: (connection: Connection) => void
}) {
  const reorder = useReorderConnections()
  const [selected, setSelected] = useState<Connection | null>(null)
  const [removing, setRemoving] = useState<Connection | null>(null)

  function onReorder(ids: string[]) {
    reorder.mutate(ids, {
      // A 409 says the list changed under the user, which a generic message would hide.
      onError: (err) =>
        toast.error(err instanceof ApiError && err.status === 409 ? err.message : "Could not save the new order"),
    })
  }

  return (
    <>
      {connections.length ? (
        <SortableGrid ids={connections.map((connection) => connection.id)} label="Connections" onReorder={onReorder}>
          {connections.map((connection) => (
            <ConnectionCard
              key={connection.id}
              connection={connection}
              status={statuses[connection.id]}
              reorderable={reorderable}
              onDetails={() => setSelected(connection)}
              onRemove={() => setRemoving(connection)}
              onReconnect={() => onReconnect(connection)}
            />
          ))}
        </SortableGrid>
      ) : (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyDescription>No connections match your filters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <ConnectionDetailsSheet connection={selected} onOpenChange={(open) => !open && setSelected(null)} />
      <RemoveConnectionDialog connection={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

// The search and filters sit above the grid, so their state lives here and
// the grid only shows what it is given.
function ConnectedAccounts({
  connections,
  onAdd,
  onReconnect,
}: {
  connections: Connection[]
  onAdd: () => void
  onReconnect: (connection: Connection) => void
}) {
  const statuses = useConnectionStatuses(connections)
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const [query, setQuery] = useState("")
  const [forge, setForge] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const filtering = forge !== ALL || status !== ALL

  function clearFilters() {
    setForge(ALL)
    setStatus(ALL)
  }

  const filtered = useMemo(
    () =>
      connections.filter(
        (connection) =>
          matchesQuery(
            query,
            connection.accountLogin,
            connection.host,
            connection.createdBy?.name ?? "",
            connection.createdBy?.email ?? "",
          ) &&
          (forge === ALL || forgeKey(connection) === forge) &&
          // Connections still being checked match no specific status.
          (status === ALL || statuses[connection.id] === status),
      ),
    [connections, query, forge, status, statuses],
  )

  const activeFilters = [
    { label: "Forge", value: selectedLabel(forge, FORGE_KIND_OPTIONS), onRemove: () => setForge(ALL) },
    { label: "Status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => setStatus(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  // The saved order is the whole list's, so a filtered subset cannot be reordered.
  const narrowed = filtering || query.trim() !== ""
  const reorderable = canManage && connections.length > 1 && !narrowed

  return (
    <>
      <FilterToolbar align="start">
        <SearchInput label="Search connections" value={query} onChange={setQuery} />
        <FilterPopover active={filtering} onClear={clearFilters} align="start">
          <FilterSelect
            id="connection-forge"
            label="Forge"
            allLabel="All forges"
            value={forge}
            onValueChange={setForge}
            options={FORGE_KIND_OPTIONS}
          />
          <FilterSelect
            id="connection-status"
            label="Status"
            allLabel="All statuses"
            value={status}
            onValueChange={setStatus}
            options={STATUS_OPTIONS}
          />
        </FilterPopover>
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add connection
        </Button>
        {/* Last, so applying a filter does not shift the controls. */}
        <ActiveFilterChips filters={activeFilters} />
      </FilterToolbar>
      {canManage && connections.length > 1 && (
        <p className="text-sm text-muted-foreground">
          {narrowed ? "Clear search and filters to reorder." : "Drag cards by their handle to reorder them."}
        </p>
      )}
      <ConnectionGrid connections={filtered} statuses={statuses} reorderable={reorderable} onReconnect={onReconnect} />
    </>
  )
}

// Rendered once beside the grid rather than inside a card's menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
function RemoveConnectionDialog({
  connection,
  onOpenChange,
}: {
  connection: Connection | null
  onOpenChange: (open: boolean) => void
}) {
  const remove = useDeleteConnection()

  async function onRemove() {
    if (!connection) return
    try {
      await remove.mutateAsync(connection.id)
      onOpenChange(false)
      toast.success("Connection removed")
    } catch {
      toast.error("Could not remove the connection")
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {connection && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {connection.accountLogin}?</DialogTitle>
              <DialogDescription>
                Sentryward will stop reviewing its repositories and remove their webhooks. Their review history is deleted
                too. This cannot be undone.
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
                Remove connection
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// A connection is self-hosted unless it is on the provider's cloud host: the
// fixed host of a token option, or the cloud app itself.
function isSelfHosted(connection: Connection) {
  const cloud = PROVIDERS[connection.provider].hosting.cloud.method
  return cloud.type === "token" ? connection.host !== cloud.fixedHost : connection.kind !== "github_app"
}

function AddConnectionSheet({
  open,
  onOpenChange,
  availableApps,
  oauthHosts,
  reconnect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableApps: Provider[]
  oauthHosts: Partial<Record<Provider, string>>
  // Presets the provider and host of a connection whose credentials were rejected.
  reconnect?: Connection | null
}) {
  const initialProvider = reconnect?.provider ?? PROVIDER_IDS[0]!
  const initialSelfHosted = reconnect ? isSelfHosted(reconnect) : false
  const [providerId, setProviderId] = useState<Provider>(initialProvider)
  const [selfHosted, setSelfHosted] = useState(initialSelfHosted)

  const provider = PROVIDERS[providerId]
  // The checkbox stays ticked across providers; one without a self-hosted
  // option falls back to its cloud one.
  const hosting = (selfHosted && provider.hosting.selfHosted) || provider.hosting.cloud
  const method = hosting.method
  const oauthHost = oauthHosts[providerId]
  const oauth =
    method.type === "token" && availableApps.includes(providerId) && offersOAuth(provider, method, oauthHost)
      ? method.oauth
      : undefined

  function handleOpenChange(next: boolean) {
    if (!next) {
      setProviderId(initialProvider)
      setSelfHosted(initialSelfHosted)
    }
    onOpenChange(next)
  }

  // Only the reconnected connection's own option starts with its host filled in.
  const presetHost =
    reconnect && providerId === reconnect.provider && selfHosted === initialSelfHosted ? reconnect.host : undefined

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{reconnect ? `Reconnect ${reconnect.accountLogin}` : "Add connection"}</SheetTitle>
          <SheetDescription>
            {reconnect
              ? "Connect the same account again to resume automatic reviews. Its repositories and review history are kept."
              : "Connect a code host to choose repositories to review."}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider">Provider</FieldLabel>
              <SearchableSelect
                id="provider"
                value={providerId}
                onValueChange={(value) => setProviderId(value as Provider)}
                searchPlaceholder="Search providers..."
                options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label, icon: PROVIDERS[id].icon }))}
              />
            </Field>
            {provider.hosting.selfHosted && (
              <Field orientation="horizontal">
                <Checkbox
                  id="self-hosted"
                  checked={selfHosted}
                  onCheckedChange={(checked) => setSelfHosted(checked === true)}
                />
                <FieldLabel htmlFor="self-hosted">Self-hosted</FieldLabel>
              </Field>
            )}
          </FieldGroup>
          <Separator />
          <section className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{hosting.hint}</p>
            {method.type === "app" ? (
              availableApps.includes(providerId) ? (
                <Button asChild>
                  <a href={installHref(method.installHref)}>Install {method.name}</a>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">The {method.name} is not configured on this server.</p>
              )
            ) : (
              <>
                {oauth && (
                  <>
                    <Button asChild>
                      <a href={installHref(oauth.startHref)}>Connect with {oauth.name}</a>
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      Signs in on {oauthHost}; comments are posted as the account that signs in. Or paste an access
                      token instead:
                    </p>
                  </>
                )}
                <TokenForm
                  key={`${providerId}-${hosting === provider.hosting.selfHosted}`}
                  provider={providerId}
                  method={method}
                  initialHost={presetHost}
                  onConnected={() => handleOpenChange(false)}
                />
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function InstallationTab() {
  useReturnToast()
  const { data, isPending } = useConnections()
  const [adding, setAdding] = useState(false)
  // Kept after the sheet closes so its closing animation still shows the same
  // connection; replaced on the next open, which remounts the sheet by key.
  const [reconnecting, setReconnecting] = useState<Connection | null>(null)

  function openSheet(connection: Connection | null) {
    setReconnecting(connection)
    setAdding(true)
  }

  const sheet = (
    <AddConnectionSheet
      key={reconnecting?.id ?? "add"}
      open={adding}
      onOpenChange={setAdding}
      availableApps={data?.availableApps ?? []}
      oauthHosts={data?.oauthHosts ?? {}}
      reconnect={reconnecting}
    />
  )

  if (isPending) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-44 rounded-xl" />
        ))}
      </div>
    )
  }

  if (!data?.connections.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug />
            </EmptyMedia>
            <EmptyTitle>No connections yet</EmptyTitle>
            <EmptyDescription>Connect GitHub or GitLab to start reviewing.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => openSheet(null)}>
              <Plus />
              Add connection
            </Button>
          </EmptyContent>
        </Empty>
        {sheet}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ConnectedAccounts connections={data.connections} onAdd={() => openSheet(null)} onReconnect={openSheet} />
      {sheet}
    </div>
  )
}
