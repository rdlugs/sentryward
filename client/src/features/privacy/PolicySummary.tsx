import type { ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import { plural } from "@/lib/plural"
import type { WorkspacePrivacy } from "./api"

// An empty list allows everything. Saving checks that a workspace list stays
// within the instance's, so a set workspace list is the narrower one.
function narrower<T>(instance: T[], workspace: T[]): T[] {
  return workspace.length ? workspace : instance
}

function Row(props: { label: string; byInstance: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd className="flex flex-1 flex-wrap items-center gap-1.5 text-sm">
        {props.children}
        {props.byInstance && (
          <Badge variant="secondary" className="font-normal">
            Set by instance
          </Badge>
        )}
      </dd>
    </div>
  )
}

// What reviews in this workspace actually run under: the stricter of the
// instance and workspace layers, as the worker computes it.
export function PolicySummary({ data }: { data: WorkspacePrivacy }) {
  const { instance, workspace, effective } = data
  const providers = narrower(instance.allowedProviders, workspace.allowedProviders)
  const hosts = narrower(instance.allowedHosts, workspace.allowedHosts)
  // The instance is the source when it restricts and the workspace adds nothing narrower.
  const providersByInstance = instance.allowedProviders.length > 0 && !workspace.allowedProviders.length
  const hostsByInstance = instance.allowedHosts.length > 0 && !workspace.allowedHosts.length
  const retentionByInstance =
    effective.retentionDays !== null &&
    effective.retentionDays === instance.retentionDays &&
    (workspace.retentionDays === null || workspace.retentionDays >= effective.retentionDays)

  return (
    <dl aria-label="Policy in effect" className="divide-y">
      <Row label="Providers" byInstance={providersByInstance}>
        {providers.length ? (
          providers.map((provider) => {
            const { icon: Icon, label } = LLM_PROVIDERS[provider]
            return (
              <Badge key={provider} variant="outline">
                <Icon />
                {label}
              </Badge>
            )
          })
        ) : (
          <span>Any provider</span>
        )}
      </Row>
      <Row label="Hosts" byInstance={hostsByInstance}>
        {hosts.length ? (
          hosts.map((host) => (
            <Badge key={host} variant="outline" className="font-mono font-normal">
              {host}
            </Badge>
          ))
        ) : (
          <span>Any host</span>
        )}
      </Row>
      <Row label="Local only" byInstance={instance.localOnly}>
        <span>{effective.localOnly ? "On" : "Off"}</span>
      </Row>
      <Row label="Review data kept" byInstance={retentionByInstance}>
        <span>{effective.retentionDays === null ? "Forever" : plural(effective.retentionDays, "day")}</span>
      </Row>
    </dl>
  )
}
