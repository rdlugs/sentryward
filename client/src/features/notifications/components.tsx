import { useMemo, useState } from "react"
import { Link } from "react-router"
import { AlertTriangle } from "lucide-react"
import { toast } from "sonner"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRepos } from "@/features/forge/api"
import { timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import {
  errorMessage,
  MAX_DELIVERY_ATTEMPTS,
  useNotificationDeliveries,
  useUpdateNotificationTarget,
  type DeliveryEvent,
  type LastDelivery,
  type NotificationTarget,
} from "./api"
import { deliveryOutcome, deliverySummary, retryNote, scopeSummary } from "./delivery"

// Pieces both tabs of the Notifications page use.

const DELIVERY_EVENT_LABELS: Record<DeliveryEvent, string> = {
  blocked: "Blocked",
  failed: "Failed",
  resolved: "Resolved",
  completed: "Completed",
  test: "Test",
  digest: "Digest",
}

const OUTCOME_COLORS: Record<LastDelivery["status"], string> = {
  sent: "bg-emerald-500",
  failed: "bg-destructive",
  pending: "bg-amber-500",
}

export function OutcomeDot({ status }: { status: LastDelivery["status"] }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", OUTCOME_COLORS[status])} aria-hidden />
}

export function LastDeliveryCell({ delivery }: { delivery: LastDelivery | null }) {
  if (!delivery) return <span className="text-muted-foreground">Never</span>
  const title = [retryNote(delivery), delivery.error].filter(Boolean).join(". ")
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        delivery.status === "failed" && "text-destructive",
      )}
      title={title || undefined}
    >
      <OutcomeDot status={delivery.status} />
      {deliveryOutcome(delivery)} · {timeAgo(delivery.createdAt)}
    </span>
  )
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

const DELIVERIES_PAGE_SIZE = 20

export function DeliveriesSheet({
  target,
  onOpenChange,
}: {
  target: NotificationTarget
  onOpenChange: (open: boolean) => void
}) {
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(DELIVERIES_PAGE_SIZE)
  const { data, isPending, isError } = useNotificationDeliveries(target.id, page, size)

  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Deliveries to {target.name}</SheetTitle>
          <SheetDescription>
            Every delivery, tests included, newest first. A delivery that fails is tried up to{" "}
            {MAX_DELIVERY_ATTEMPTS} times. The last 30 days are kept, up to 100 per target.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">
          {isPending ? (
            <Skeleton className="h-40 w-full" />
          ) : isError ? (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Could not load deliveries.</AlertTitle>
            </Alert>
          ) : data.total === 0 ? (
            <p className="text-sm text-muted-foreground">No deliveries yet. Send a test to check this target.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.deliveries.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="align-top whitespace-nowrap text-muted-foreground">
                        {formatDateTime(delivery.createdAt)}
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="flex flex-col gap-1">
                          <span>{DELIVERY_EVENT_LABELS[delivery.event]}</span>
                          {delivery.jobId && (
                            <Link to={`/reviews/${delivery.jobId}`} className="text-xs underline underline-offset-4">
                              View review
                            </Link>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="align-top whitespace-normal">
                        <div className="flex flex-col gap-1">
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5",
                              delivery.status === "failed" && "text-destructive",
                            )}
                          >
                            <OutcomeDot status={delivery.status} />
                            {deliveryOutcome(delivery)}
                          </span>
                          {retryNote(delivery) && (
                            <span className="text-xs text-muted-foreground">{retryNote(delivery)}</span>
                          )}
                          {delivery.error && (
                            <span className="text-xs break-words text-muted-foreground">{delivery.error}</span>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <TablePagination
                page={page}
                size={size}
                total={data.total}
                onPageChange={setPage}
                onSizeChange={(next) => {
                  setSize(next)
                  setPage(1)
                }}
              />
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// Pausing keeps a target's settings, so it can be turned back on without
// adding it again (and, for a webhook, getting a new secret). A target paused
// because its repositories were removed is turned on by saving repositories in
// its edit panel, so the switch stays off (the hint under its name says so).
export function TargetActiveSwitch({ target, canManage }: { target: NotificationTarget; canManage: boolean }) {
  const updateTarget = useUpdateNotificationTarget()

  async function setActive(active: boolean) {
    try {
      await updateTarget.mutateAsync({ id: target.id, active })
      toast.success(`${active ? "Resumed" : "Paused"} ${target.name}`)
    } catch (error) {
      toast.error(errorMessage(error, "Could not update the target"))
    }
  }

  return (
    <Switch
      // Shows the requested state while the change is saved and the list
      // refetched; on an error it falls back to what the server has.
      checked={updateTarget.isPending ? (updateTarget.variables.active ?? target.active) : target.active}
      onCheckedChange={setActive}
      disabled={!canManage || updateTarget.isPending || target.pauseCause === "scope"}
      aria-label={`Active: ${target.name}`}
    />
  )
}

// The name, and under it why the server paused the target, if it did.
function useRepoNames() {
  const { data } = useRepos()
  return useMemo(() => new Map((data?.repos ?? []).map((repo) => [repo.id, repo.fullPath])), [data])
}

export function TargetName({ target }: { target: NotificationTarget }) {
  const scope = scopeSummary(target, useRepoNames())
  const delivery = deliverySummary(target)
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">{target.name}</span>
      {scope && <span className="text-xs text-muted-foreground">{scope}</span>}
      {delivery && <span className="text-xs text-muted-foreground">{delivery}</span>}
      {target.pausedReason && (
        <span className="inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          {target.pausedReason}
        </span>
      )}
    </div>
  )
}

