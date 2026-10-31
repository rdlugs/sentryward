import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { STATUS_LABELS, type LlmConnectionStatus } from "./api"
import type { ConnectionState } from "./health"

const DANGER = "border-destructive/40 text-destructive"

const STATE_BADGES: Record<Exclude<ConnectionState, "checking">, { label: string; className: string; title: string }> = {
  active: {
    label: STATUS_LABELS.active,
    className: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
    title: "The provider accepts the stored credentials",
  },
  rejected: {
    label: STATUS_LABELS.revoked,
    className: DANGER,
    title: "The provider rejected the stored credentials; replace this connection",
  },
  unverified: {
    label: STATUS_LABELS.unreachable,
    className: "border-amber-600/40 text-amber-700 dark:text-amber-400",
    title: "Could not verify the connection with the provider",
  },
  blocked: {
    label: STATUS_LABELS.blocked,
    className: DANGER,
    title: "The privacy policy does not allow this connection; reviews cannot use it",
  },
  unreadable: {
    label: "Re-enter key",
    className: DANGER,
    title: "The server's encryption key changed, so this key can't be read; replace it",
  },
  server: {
    label: "Server key",
    className: "text-foreground",
    title: "Reviews use the key the server is configured with",
  },
  none: {
    label: "Not connected",
    className: "text-muted-foreground",
    title: "No key is stored for this provider",
  },
}

const STATUS_STATES: Record<LlmConnectionStatus, ConnectionState> = {
  active: "active",
  revoked: "rejected",
  unreachable: "unverified",
  blocked: "blocked",
}

export function ConnectionStateBadge({ state }: { state: ConnectionState }) {
  if (state === "checking") {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking...
      </span>
    )
  }

  const badge = STATE_BADGES[state]
  return (
    <Badge variant="outline" className={cn(badge.className)} title={badge.title}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {badge.label}
    </Badge>
  )
}

export function ApiKeyStatusBadge({ status }: { status: LlmConnectionStatus | undefined }) {
  return <ConnectionStateBadge state={status ? STATUS_STATES[status] : "checking"} />
}
