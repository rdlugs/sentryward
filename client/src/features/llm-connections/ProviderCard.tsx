import { Link } from "react-router"
import { Info, KeyRound, MoreHorizontal, Plus, RefreshCw, RotateCw, ShieldAlert, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDate, timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import { useApiKeyStatus, type ApiKey } from "./api"
import { ConnectionStateBadge } from "./ApiKeyStatusBadge"
import { keyText } from "./format"
import { connectionState, isCheckable, type ConnectionState } from "./health"
import { LLM_PROVIDERS } from "./providers"

// The card's ring, so the cards highlight exactly what the header and the
// sidebar count as needing attention; an unverified check may be the host's
// hiccup, so it warns rather than alarms, like its badge.
const ATTENTION: Partial<Record<ConnectionState, string>> = {
  blocked: "ring-destructive/40",
  unreadable: "ring-destructive/40",
  rejected: "ring-destructive/40",
  unverified: "ring-amber-600/40",
}

// Written out on the card rather than left in a tooltip, which touch screens
// never show.
function reason(state: ConnectionState, key: ApiKey) {
  const { label } = LLM_PROVIDERS[key.provider]
  switch (state) {
    case "blocked":
      return "The privacy policy does not allow this provider or its host, so reviews cannot use it."
    case "unreadable":
      return "The server's encryption key changed, so the stored key can't be read. Enter it again."
    case "rejected":
      return "The provider rejected the stored key. Replace it to keep reviewing with it."
    case "unverified":
      return "The provider could not be reached to verify this connection."
    case "checking":
      return "Checking the connection with the provider."
    case "active":
      return `Reviews with ${label} models use this connection.`
    case "server":
      return `Reviews use the server's ${label} key. Add your own to use your account or host.`
    case "none":
      return key.provider === "ollama"
        ? "Connect an Ollama server to review with models you host."
        : `Add a key to review with ${label} models.`
  }
}

function ProviderActions({
  apiKey,
  canRecheck,
  onDetails,
  onRecheck,
  onReplace,
  onRemove,
}: {
  apiKey: ApiKey
  canRecheck: boolean
  onDetails: () => void
  onRecheck: () => void
  onReplace: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${LLM_PROVIDERS[apiKey.provider].label}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onDetails}>
          <Info />
          Details
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRecheck} disabled={!canRecheck}>
          <RotateCw />
          Check again
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onReplace}>
          <RefreshCw />
          Replace key
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ProviderCard({
  apiKey,
  onDetails,
  onConnect,
  onRemove,
}: {
  apiKey: ApiKey
  onDetails: () => void
  // Opens the key sheet: a first connection, or a replacement for a stored one.
  onConnect: () => void
  onRemove: () => void
}) {
  const provider = LLM_PROVIDERS[apiKey.provider]
  const checkable = isCheckable(apiKey)
  const { status, checkedAt, isFetching, refetch } = useApiKeyStatus(apiKey.provider, { enabled: checkable })
  // The last result stays up while a check reruns, as in the header and the
  // sidebar; only the recheck controls show the run.
  const state = connectionState(apiKey, status)
  const recheck = () => void refetch()

  function mainAction() {
    switch (state) {
      case "blocked":
        return (
          <>
            {!apiKey.stored && (
              <Button size="sm" disabled>
                <Plus />
                Connect
              </Button>
            )}
            <Button size="sm" variant="outline" asChild>
              <Link to="/privacy">
                <ShieldAlert />
                Review policy
              </Link>
            </Button>
          </>
        )
      case "unreadable":
      case "rejected":
        return (
          <Button size="sm" onClick={onConnect}>
            <KeyRound />
            Replace key
          </Button>
        )
      case "unverified":
        return (
          <Button size="sm" onClick={recheck} disabled={isFetching}>
            <RotateCw className={cn(isFetching && "animate-spin")} />
            Check again
          </Button>
        )
      case "server":
        return (
          <Button size="sm" variant="outline" onClick={onConnect}>
            <KeyRound />
            Use my own key
          </Button>
        )
      case "none":
        return (
          <Button size="sm" onClick={onConnect}>
            <Plus />
            Connect
          </Button>
        )
      case "checking":
      case "active":
        return (
          <Button size="sm" variant="outline" onClick={onDetails}>
            <Info />
            Details
          </Button>
        )
    }
  }

  return (
    <li className="min-w-0" aria-label={provider.label} data-attention={ATTENTION[state] ? state : undefined}>
      <Card size="sm" className={cn("h-full", ATTENTION[state])}>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div className="flex items-start gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
              <provider.icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{provider.label}</p>
              {apiKey.stored && (
                <p className="truncate text-muted-foreground" title={apiKey.baseUrl ?? undefined}>
                  <span className="font-mono">{keyText(apiKey)}</span> · <span>{apiKey.baseUrl ?? "Official API"}</span>
                </p>
              )}
            </div>
            {apiKey.stored && (
              <ProviderActions
                apiKey={apiKey}
                canRecheck={checkable && !isFetching}
                onDetails={onDetails}
                onRecheck={recheck}
                onReplace={onConnect}
                onRemove={onRemove}
              />
            )}
          </div>
          <div>
            <ConnectionStateBadge state={state} />
          </div>
          <p className="text-muted-foreground">{reason(state, apiKey)}</p>
          {apiKey.stored && (
            <p className="mt-auto text-xs text-muted-foreground">
              {apiKey.updatedAt && (
                <span title={new Date(apiKey.updatedAt).toLocaleString()}>Updated {formatDate(apiKey.updatedAt)}</span>
              )}
              {apiKey.updatedAt && checkedAt && " · "}
              {checkedAt && (
                <span title={new Date(checkedAt).toLocaleString()}>
                  checked {timeAgo(new Date(checkedAt).toISOString())}
                </span>
              )}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex-wrap gap-2">
          {mainAction()}
          {apiKey.stored && !["checking", "active"].includes(state) && (
            <Button size="sm" variant="ghost" onClick={onDetails}>
              Details
            </Button>
          )}
        </CardFooter>
      </Card>
    </li>
  )
}
