import { Link } from "react-router"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { FolderGit2, Info, MoreHorizontal, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatDate } from "@/lib/time"
import { cn } from "@/lib/utils"
import type { Connection, ConnectionStatus } from "./api"
import { ConnectionStatusBadge } from "./ConnectionStatusBadge"
import { kindLabel } from "./forgeKind"
import { PROVIDERS } from "./providers"
import { DragHandle } from "./SortableGrid"

function ConnectionActions({
  connection,
  onDetails,
  onRemove,
}: {
  connection: Connection
  onDetails: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${connection.accountLogin}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onDetails}>
          <Info />
          Details
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={`/repositories?tab=repositories&account=${connection.id}`}>
            <FolderGit2 />
            Manage repositories
          </Link>
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

export function ConnectionCard({
  connection,
  status,
  reorderable,
  onDetails,
  onRemove,
  onReconnect,
}: {
  connection: Connection
  status: ConnectionStatus | undefined
  // Off while filtering, for members, or with a single card.
  reorderable: boolean
  onDetails: () => void
  onRemove: () => void
  onReconnect: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: connection.id,
    disabled: !reorderable,
  })
  const provider = PROVIDERS[connection.provider]
  const revoked = status === "revoked"
  const count = connection.repositoryCount

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("min-w-0", isDragging && "relative z-10 opacity-80")}
      aria-label={connection.accountLogin}
    >
      <Card size="sm" className={cn("h-full", revoked && "ring-destructive/40", isDragging && "shadow-lg")}>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div className="flex items-start gap-2">
            {reorderable && (
              <DragHandle
                label={`Reorder ${connection.accountLogin}`}
                handleRef={setActivatorNodeRef}
                attributes={attributes}
                listeners={listeners}
              />
            )}
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
              <provider.icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{connection.accountLogin}</p>
              <p className="truncate text-muted-foreground">
                <span>{connection.host}</span> · <span>{kindLabel(connection)}</span>
              </p>
            </div>
            <ConnectionActions connection={connection} onDetails={onDetails} onRemove={onRemove} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ConnectionStatusBadge status={status} />
            <span className="text-muted-foreground tabular-nums">
              {count} {count === 1 ? "repository" : "repositories"}
            </span>
          </div>
          <p className="mt-auto text-xs text-muted-foreground">
            Added by <span title={connection.createdBy?.email}>{connection.createdBy?.name ?? "Removed user"}</span>
            {" · "}
            <span title={new Date(connection.createdAt).toLocaleString()}>{formatDate(connection.createdAt)}</span>
          </p>
        </CardContent>
        <CardFooter className="gap-2">
          {revoked ? (
            // Connecting the same account again swaps in new credentials and keeps its repositories.
            <Button size="sm" onClick={onReconnect}>
              <RefreshCw />
              Reconnect
            </Button>
          ) : (
            <Button size="sm" variant="outline" asChild>
              <Link to={`/repositories?tab=repositories&account=${connection.id}`}>
                <FolderGit2 />
                Manage repositories
              </Link>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onDetails}>
            Details
          </Button>
        </CardFooter>
      </Card>
    </li>
  )
}
