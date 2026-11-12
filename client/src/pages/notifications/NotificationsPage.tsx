import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { NotificationTargets } from "@/features/notifications/NotificationTargets"

export function NotificationsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Notifications"
        description="Email about your own changes, and the webhooks, Slack, Discord and Teams channels, Google Chat spaces and email your workspace sends review results to."
      />
      <NotificationTargets />
    </PageShell>
  )
}
