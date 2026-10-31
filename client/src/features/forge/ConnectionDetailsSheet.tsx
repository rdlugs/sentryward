import { Link } from "react-router"
import { Copy, ExternalLink, RotateCw } from "lucide-react"
import { toast } from "sonner"
import { DetailRow, Section } from "@/components/DetailSection"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { StatusBadge, VerdictBadge } from "@/features/reviews/badges"
import { changeLabel } from "@/features/reviews/links"
import { cn } from "@/lib/utils"
import { useConnectionDetails, useConnectionStatus, type Connection, type ConnectionDetails } from "./api"
import { ConnectionStatusBadge } from "./ConnectionStatusBadge"
import { PROVIDERS } from "./providers"

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

function CopyableId({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(`${label} copied`)
    } catch {
      toast.error(`Could not copy the ${label.toLowerCase()}`)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 truncate font-mono text-xs">{value}</code>
      <Button variant="ghost" size="icon" className="size-7" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
        <Copy />
      </Button>
    </div>
  )
}

function StatusRow({ connectionId, appInstall }: { connectionId: string; appInstall: boolean }) {
  const { status, isFetching, refetch } = useConnectionStatus(connectionId)
  return (
    <>
      <DetailRow label="Status">
        <div className="flex items-center gap-2">
          <ConnectionStatusBadge status={isFetching ? undefined : status} />
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RotateCw className={cn(isFetching && "animate-spin")} />
            Check again
          </Button>
        </div>
      </DetailRow>
      {status === "revoked" && !isFetching && (
        <dd className="col-span-2">
          <Alert variant="destructive">
            {/* Removing an app connection deletes its review history, and a
                reinstall reattaches it anyway. */}
            <AlertDescription>
              {appInstall
                ? "The app is no longer installed or is suspended. Install it again to reattach these repositories and their review history."
                : "The forge rejected the stored credentials, so automatic reviews are paused. Connect the same account again to resume; its repositories and review history are kept."}
            </AlertDescription>
          </Alert>
        </dd>
      )}
    </>
  )
}

function Repositories({ repositories }: { repositories: ConnectionDetails["repositories"] }) {
  if (!repositories.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No repositories enabled.{" "}
        <Link to="/repositories" className="underline underline-offset-4">
          Choose repositories
        </Link>
      </p>
    )
  }
  return (
    <ul className="flex flex-col divide-y rounded-md border text-sm">
      {repositories.map((repo) => (
        <li key={repo.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <div className="min-w-0">
            <a
              href={repo.webUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-full items-center gap-1 font-medium hover:underline"
            >
              <span className="truncate">{repo.fullPath}</span>
              <ExternalLink className="size-3.5 shrink-0" />
            </a>
            <p className="text-xs text-muted-foreground">{repo.defaultBranch}</p>
          </div>
          <Badge
            variant="outline"
            title={repo.webhook.error}
            className={cn(
              "shrink-0",
              repo.webhook.active
                ? "border-emerald-600/40 text-emerald-700 dark:text-emerald-400"
                : "border-amber-600/40 text-amber-700 dark:text-amber-400",
            )}
          >
            {repo.webhook.active ? "Webhook active" : "No webhook"}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

function RecentReviews({ reviews }: { reviews: ConnectionDetails["reviews"] }) {
  if (!reviews.total) {
    return <p className="text-sm text-muted-foreground">No reviews yet.</p>
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {reviews.total} {reviews.total === 1 ? "review" : "reviews"} in total
      </p>
      <ul className="flex flex-col divide-y rounded-md border text-sm">
        {reviews.recent.map((review) => (
          <li key={review.id}>
            <Link
              to={`/reviews/${review.id}`}
              className="flex items-center justify-between gap-3 px-3 py-2 hover:bg-muted/50"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {review.repository.fullPath} {changeLabel(review.repository.provider, review.number)}
                </p>
                <p className="text-xs text-muted-foreground">{formatDateTime(review.createdAt)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusBadge status={review.status} />
                <VerdictBadge verdict={review.verdict} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

function DetailsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-16 w-full" />
    </div>
  )
}

export function ConnectionDetailsSheet({
  connection,
  onOpenChange,
}: {
  connection: Connection | null
  onOpenChange: (open: boolean) => void
}) {
  const details = useConnectionDetails(connection?.id ?? null)
  const provider = connection ? PROVIDERS[connection.provider] : null
  const kind = connection && provider ? (provider.kindLabel[connection.kind] ?? connection.kind) : ""
  const data = details.data

  return (
    <Sheet open={connection !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-lg">
        {connection && provider && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <provider.icon className="size-4" />
                {connection.accountLogin}
              </SheetTitle>
              <SheetDescription>{kind}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-4">
              <Section title="Overview">
                <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
                  <DetailRow label="Forge">{provider.label}</DetailRow>
                  <DetailRow label="Host">{connection.host}</DetailRow>
                  <DetailRow label="Connection type">{kind}</DetailRow>
                  <StatusRow connectionId={connection.id} appInstall={connection.kind === "github_app"} />
                  <DetailRow label="Created">{formatDateTime(connection.createdAt)}</DetailRow>
                  {data && <DetailRow label="Last updated">{formatDateTime(data.connection.updatedAt)}</DetailRow>}
                </dl>
              </Section>
              <Separator />
              {details.isPending ? (
                <DetailsSkeleton />
              ) : !data ? (
                <p className="text-sm text-muted-foreground">Could not load connection details.</p>
              ) : (
                <>
                  <Section title={`Repositories (${data.repositories.length})`}>
                    <Repositories repositories={data.repositories} />
                  </Section>
                  <Separator />
                  <Section title="Recent reviews">
                    <RecentReviews reviews={data.reviews} />
                  </Section>
                  <Separator />
                  <Section title="Technical">
                    <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
                      <DetailRow label="Connection ID">
                        <CopyableId label="Connection ID" value={data.connection.id} />
                      </DetailRow>
                      {data.connection.installationId && (
                        <DetailRow label="Installation ID">
                          <CopyableId label="Installation ID" value={data.connection.installationId} />
                        </DetailRow>
                      )}
                    </dl>
                  </Section>
                </>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
