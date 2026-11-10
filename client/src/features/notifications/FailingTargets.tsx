import { useState } from "react"
import { CheckCircle2, CircleHelp, History, Loader2, MoreHorizontal, Play, Send } from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  KIND_LABELS,
  useTestNotificationTarget,
  useUpdateNotificationSettings,
  useUpdateNotificationTarget,
  type NotificationSettings,
  type NotificationTarget,
} from "./api"
import { DeliveriesSheet, LastDeliveryCell, TargetName } from "./components"
import { causeHint, deliveryDetail, pendingRetryDetail, type FailingRow, type FailingStatus } from "./delivery"

const STATUS_LABELS: Record<FailingStatus, string> = { paused: "Paused", failing: "Failing", retrying: "Retrying" }

const STATUS_BADGES: Record<FailingStatus, { variant: "destructive" | "secondary" | "outline"; className?: string }> = {
  paused: { variant: "destructive" },
  failing: {
    variant: "outline",
    className: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  retrying: { variant: "secondary" },
}

function StatusBadge({ status }: { status: FailingStatus }) {
  const { variant, className } = STATUS_BADGES[status]
  return (
    <Badge variant={variant} className={className}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}

// "2 paused · 1 failing · 1 retrying", leaving out the empty groups.
function summary(rows: FailingRow[]) {
  return (["paused", "failing", "retrying"] as const)
    .map((status) => [status, rows.filter((row) => row.status === status).length] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(" · ")
}

// The offered limits; the current one is added when it is something else (set
// through the API, say), so the select can always show it.
const LIMIT_OPTIONS = [1, 2, 3, 5, 10, 20]

function limitLabel(limit: number) {
  return limit === 0 ? "Never" : `${limit} failure${limit === 1 ? "" : "s"}`
}

const HOW_IT_WORKS =
  "Each delivery is tried up to 5 times. When every try fails, or the endpoint refuses it, that counts as one " +
  "failure in a row; a successful delivery, tests included, resets the count. A target is paused when the count " +
  "reaches this limit, and at once when its endpoint says it no longer exists (410, or 404 from Slack). Owners and " +
  "admins are emailed when that happens."

// The limit sits beside the list it explains. Admins change it in place; a
// change saves at once.
function AutoPauseControl({ settings, canManage }: { settings: NotificationSettings; canManage: boolean }) {
  const updateSettings = useUpdateNotificationSettings()
  const limit = settings.autoPauseAfter
  const options = [...new Set([0, ...LIMIT_OPTIONS, limit])].sort((a, b) => a - b)

  async function change(value: string) {
    try {
      await updateSettings.mutateAsync({ autoPauseAfter: Number(value) })
      toast.success(Number(value) === 0 ? "Targets will never be paused" : `Targets pause after ${limitLabel(Number(value))}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the limit")
    }
  }

  const help = (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7" aria-label="How auto-pause works">
          <CircleHelp />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-sm">
        {HOW_IT_WORKS}
      </PopoverContent>
    </Popover>
  )

  if (!canManage) {
    return (
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <span>
          {limit === 0 ? "Never pauses" : `Pauses after ${limitLabel(limit)} in a row`} (set by admins)
        </span>
        {help}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="auto-pause-after" className="text-sm font-normal whitespace-nowrap text-muted-foreground">
        Auto-pause after
      </Label>
      <Select value={String(limit)} onValueChange={change} disabled={updateSettings.isPending}>
        <SelectTrigger id="auto-pause-after" size="sm" className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {limitLabel(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {help}
    </div>
  )
}

// How close a target is to being paused. A target paused because its endpoint
// is gone was never counting towards the limit, so it says that instead.
function FailureCount({ row, limit }: { row: FailingRow; limit: number }) {
  const { target, status } = row
  if (status === "paused" && target.pauseCause === "gone") {
    return <span className="text-sm text-destructive">Endpoint gone</span>
  }
  if (limit === 0) {
    return (
      <span className="text-sm tabular-nums">
        {target.consecutiveFailures} <span className="text-muted-foreground">(no limit)</span>
      </span>
    )
  }
  const value = Math.min(target.consecutiveFailures, limit)
  return (
    <div className="flex items-center gap-2">
      <div
        role="meter"
        aria-label={`Failures in a row for ${target.name}`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={value}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full rounded-full", status === "paused" ? "bg-destructive" : "bg-amber-500")}
          style={{ width: `${(value / limit) * 100}%` }}
        />
      </div>
      <span className="text-sm whitespace-nowrap tabular-nums">
        {target.consecutiveFailures} of {limit}
      </span>
    </div>
  )
}

// The outcome, and under it what went wrong and when the next try is, so
// nothing on this tab hides in a tooltip. An older delivery still retrying
// behind it gets its own line.
function LastDeliveryDetail({ target }: { target: NotificationTarget }) {
  const detail = deliveryDetail(target.lastDelivery)
  const retry = pendingRetryDetail(target)
  return (
    <div className="flex flex-col gap-0.5">
      <LastDeliveryCell delivery={target.lastDelivery} />
      {detail && <span className="text-xs break-words text-muted-foreground">{detail}</span>}
      {retry && <span className="text-xs break-words text-muted-foreground">{retry}</span>}
    </div>
  )
}

function NameWithHint({ target }: { target: NotificationTarget }) {
  const hint = causeHint(target)
  return (
    <div className="flex flex-col gap-1">
      <TargetName target={target} />
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  )
}

// Asks before resuming: the failure count resets, and the next review sends to
// the endpoint again.
function ResumeDialog({ target, onOpenChange }: { target: NotificationTarget | null; onOpenChange: (open: boolean) => void }) {
  const resume = useResume()

  async function confirm() {
    if (!target) return
    if (await resume.run(target)) onOpenChange(false)
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resume {target?.name}?</DialogTitle>
          <DialogDescription>
            Deliveries start again with the next review, and the failure count resets. Send a test first if you are not
            sure the endpoint works.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={confirm} disabled={resume.isPending}>
            {resume.isPending && <Loader2 className="animate-spin" />}
            Resume
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function useResume() {
  const updateTarget = useUpdateNotificationTarget()
  return {
    isPending: updateTarget.isPending,
    async run(target: NotificationTarget) {
      try {
        await updateTarget.mutateAsync({ id: target.id, active: true })
        toast.success(`Resumed ${target.name}`)
        return true
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not resume the target")
        return false
      }
    },
  }
}

// Admins can test any failing target and resume a paused one; everyone can
// open the history.
function RowActions({
  row,
  canManage,
  onResume,
  onViewDeliveries,
}: {
  row: FailingRow
  canManage: boolean
  onResume: () => void
  onViewDeliveries: () => void
}) {
  const { target, status } = row
  const testTarget = useTestNotificationTarget()
  const resume = useResume()

  async function sendTest() {
    try {
      const result = await testTarget.mutateAsync(target.id)
      if (!result.ok) {
        toast.error(`Test to ${target.name} failed: ${result.error}`)
      } else if (status === "paused") {
        // The endpoint works again, so the next step is one click away.
        toast.success(`Test to ${target.name} passed`, {
          description: "It is still paused.",
          action: { label: "Resume", onClick: () => void resume.run(target) },
        })
      } else {
        toast.success(`Test to ${target.name} passed`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the test")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${target.name}`}>
          {testTarget.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onViewDeliveries}>
          <History />
          View deliveries
        </DropdownMenuItem>
        {canManage && (
          <DropdownMenuItem onSelect={sendTest} disabled={testTarget.isPending}>
            <Send />
            Send test
          </DropdownMenuItem>
        )}
        {canManage && status === "paused" && (
          <DropdownMenuItem onSelect={onResume}>
            <Play />
            Resume
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function FailingTargets({
  failing,
  settings,
  canManage,
}: {
  failing: FailingRow[]
  settings: NotificationSettings
  canManage: boolean
}) {
  const isMobile = useIsMobile()
  // Kept by id so the sheet and dialog follow the target through refetches.
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [resumingId, setResumingId] = useState<string | null>(null)
  const find = (id: string | null) => failing.find((row) => row.target.id === id)?.target ?? null
  const viewing = find(viewingId)
  const resuming = find(resumingId)
  const limit = settings.autoPauseAfter

  const actions = (row: FailingRow) => (
    <RowActions
      row={row}
      canManage={canManage}
      onResume={() => setResumingId(row.target.id)}
      onViewDeliveries={() => setViewingId(row.target.id)}
    />
  )

  let body
  if (failing.length === 0) {
    body = (
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CheckCircle2 />
          </EmptyMedia>
          <EmptyTitle>All targets are delivering</EmptyTitle>
          <EmptyDescription>Targets show up here when deliveries fail or are being retried.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  } else if (isMobile) {
    body = (
      <ul className="flex flex-col gap-3" aria-label="Failing targets">
        {failing.map((row) => (
          <li key={row.target.id} className="flex flex-col gap-3 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-2">
              <NameWithHint target={row.target} />
              <StatusBadge status={row.status} />
            </div>
            <div className="flex flex-col gap-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Failures in a row</span>
                <FailureCount row={row} limit={limit} />
              </div>
              <LastDeliveryDetail target={row.target} />
            </div>
            <div className="flex justify-end">{actions(row)}</div>
          </li>
        ))}
      </ul>
    )
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Failures in a row</TableHead>
            <TableHead>Last delivery</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {failing.map((row) => (
            <TableRow key={row.target.id}>
              <TableCell className="max-w-72 align-top whitespace-normal">
                <NameWithHint target={row.target} />
              </TableCell>
              <TableCell className="align-top">
                <StatusBadge status={row.status} />
              </TableCell>
              <TableCell className="align-top">
                <Badge variant="outline">{KIND_LABELS[row.target.kind]}</Badge>
              </TableCell>
              <TableCell className="align-top">
                <FailureCount row={row} limit={limit} />
              </TableCell>
              <TableCell className="max-w-64 align-top whitespace-normal">
                <LastDeliveryDetail target={row.target} />
              </TableCell>
              <TableCell className="align-top">{actions(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{failing.length ? summary(failing) : "No failing targets"}</CardTitle>
          <CardAction>
            <AutoPauseControl settings={settings} canManage={canManage} />
          </CardAction>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
      <ResumeDialog target={resuming} onOpenChange={(open) => !open && setResumingId(null)} />
      {viewing && (
        <DeliveriesSheet key={viewing.id} target={viewing} onOpenChange={(open) => !open && setViewingId(null)} />
      )}
    </>
  )
}
