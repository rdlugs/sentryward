import { Link } from "react-router"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { ExternalLink, GripVertical, MoreHorizontal, SlidersHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Switch } from "@/components/ui/switch"
import { StatusBadge, VerdictBadge } from "@/features/reviews/badges"
import { cn } from "@/lib/utils"
import { timeAgo } from "@/lib/time"
import type { ConnectionStatus, ForgeRepo } from "./api"
import { ConnectionStatusBadge } from "./ConnectionStatusBadge"
import { PROVIDERS } from "./providers"

function RepoActions({ repo, onRemove }: { repo: ForgeRepo; onRemove: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${repo.fullPath}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem asChild>
          <Link to={`/configuration?repo=${repo.id}`}>
            <SlidersHorizontal />
            Review settings
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

function LastReview({ repo }: { repo: ForgeRepo }) {
  const review = repo.lastReview
  if (!review) return <p className="text-muted-foreground">No reviews yet</p>
  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* A verdict once the review finished; until then (or if it failed) its status. */}
      {review.verdict ? <VerdictBadge verdict={review.verdict} /> : <StatusBadge status={review.status} />}
      <Link
        to={`/reviews/${review.id}`}
        className="truncate text-muted-foreground hover:text-foreground hover:underline"
        title={new Date(review.createdAt).toLocaleString()}
      >
        {PROVIDERS[repo.account.provider].changeLabel(review.number)} · {timeAgo(review.createdAt)}
      </Link>
    </div>
  )
}

export function RepoCard({
  repo,
  status,
  reorderable,
  toggling,
  onToggle,
  onRemove,
}: {
  repo: ForgeRepo
  // The connection's credential check.
  status: ConnectionStatus | undefined
  // Off while filtering, for members, or with a single card.
  reorderable: boolean
  // Only this card's switch waits for its save.
  toggling: boolean
  onToggle: (enabled: boolean) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: repo.id,
    disabled: !reorderable,
  })
  const provider = PROVIDERS[repo.account.provider]
  // Matches the "Overrides" badge on the Configuration page.
  const custom = !repo.followGlobal && Object.keys(repo.settings).length > 0

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("min-w-0", isDragging && "relative z-10 opacity-80")}
      aria-label={repo.fullPath}
    >
      <Card size="sm" className={cn("h-full", isDragging && "shadow-lg")}>
        <CardContent className="flex flex-1 flex-col gap-3">
          <div className="flex items-start gap-2">
            {reorderable && (
              <button
                ref={setActivatorNodeRef}
                type="button"
                className="-ml-1 flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:cursor-grabbing"
                {...attributes}
                {...listeners}
                aria-label={`Reorder ${repo.fullPath}`}
              >
                <GripVertical className="size-4" />
              </button>
            )}
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background">
              <provider.icon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={repo.webUrl}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1 font-medium hover:underline"
              >
                <span className="truncate">{repo.fullPath}</span>
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              </a>
              <p className="truncate text-muted-foreground">
                <span>{repo.account.login}</span> · <span className="font-mono text-xs">{repo.defaultBranch}</span>
              </p>
            </div>
            <RepoActions repo={repo} onRemove={onRemove} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <ConnectionStatusBadge status={status} />
            <span className="text-xs text-muted-foreground">{custom ? "Custom settings" : "Global settings"}</span>
          </div>
          <div className="mt-auto">
            <LastReview repo={repo} />
          </div>
        </CardContent>
        <CardFooter className="justify-between gap-2">
          <label htmlFor={`reviews-${repo.id}`} className="text-sm">
            Reviews
          </label>
          <Switch
            id={`reviews-${repo.id}`}
            checked={repo.enabled}
            onCheckedChange={onToggle}
            aria-label={`Reviews for ${repo.fullPath}`}
            disabled={toggling}
          />
        </CardFooter>
      </Card>
    </li>
  )
}
