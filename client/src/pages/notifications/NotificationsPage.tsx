import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { NotificationTargets } from "@/features/notifications/NotificationTargets"
import { PersonalNotifications } from "@/features/notifications/PersonalNotifications"

export function NotificationsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Notifications"
        description="Webhooks, Slack channels and email that hear about blocked, failed or completed reviews."
      />
      <div className="flex flex-col gap-6">
        <PersonalNotifications />
        <NotificationTargets />
      </div>
    </PageShell>
  )
}
