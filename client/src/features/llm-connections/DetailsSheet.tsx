import { useState, type ReactNode } from "react"
import { CircleCheck, CircleX, Loader2, RotateCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ModelCombobox } from "@/features/config/ModelCombobox"
import { ApiError } from "@/lib/api"
import { timeAgo } from "@/lib/time"
import { cn } from "@/lib/utils"
import {
  useApiKeyStatus,
  useLlmCapabilities,
  useLlmModels,
  useTestLlmModel,
  type ApiKey,
  type LlmProvider,
  type ThinkingSupport,
} from "./api"
import { ConnectionStateBadge } from "./ApiKeyStatusBadge"
import { formatDate, keyText } from "./format"
import { connectionState } from "./health"
import { LLM_PROVIDERS } from "./providers"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

function TestModelForm({ apiKey }: { apiKey: ApiKey }) {
  const [model, setModel] = useState("")
  const models = useLlmModels(apiKey.provider)
  const test = useTestLlmModel()
  const modelError = test.error instanceof ApiError ? test.error.fieldErrors?.model?.[0] : undefined
  const result = test.data?.result

  function onModelChange(value: string) {
    setModel(value)
    // A result describes the model it ran, not the one now typed.
    test.reset()
  }

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        test.mutate({ provider: apiKey.provider, model: model.trim() })
      }}
    >
      <Field data-invalid={modelError ? true : undefined}>
        <FieldLabel htmlFor="test-model">Model</FieldLabel>
        <ModelCombobox
          id="test-model"
          aria-label="Model"
          value={model}
          onChange={onModelChange}
          placeholder={`${apiKey.provider}/...`}
          aria-invalid={modelError ? true : undefined}
          suggestions={{ models: models.data?.models ?? [], loading: models.isPending, error: models.isError }}
        />
        <FieldDescription>
          Runs one real generation the way a review would, which uses a little of this connection's quota.
        </FieldDescription>
        {modelError && <FieldError>{modelError}</FieldError>}
      </Field>
      {result?.ok && (
        <div role="status" className="flex flex-col gap-2 text-sm">
          <p className="flex items-center gap-2">
            <CircleCheck className="size-4 shrink-0 text-emerald-700 dark:text-emerald-400" />
            Responded in {result.latencyMs} ms, {result.inputTokens} input / {result.outputTokens} output tokens
          </p>
          {result.capabilities && (
            <div className="flex flex-wrap items-center gap-2">
              <CapabilityBadges thinking={result.capabilities.thinking} tools={result.capabilities.tools} />
              <span className="text-xs text-muted-foreground">{result.capabilities.detail}</span>
            </div>
          )}
        </div>
      )}
      {result && !result.ok && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleX className="mt-0.5 size-4 shrink-0" />
          {result.message}
        </p>
      )}
      {test.isError && !modelError && (
        <p role="alert" className="text-sm text-destructive">
          {test.error instanceof ApiError ? test.error.message : "Could not run the test"}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={!model.trim() || test.isPending}>
        {test.isPending && <Loader2 className="animate-spin" />}
        {test.isPending ? "Testing..." : "Run test"}
      </Button>
    </form>
  )
}

const THINKING_LABELS: Record<ThinkingSupport, string> = {
  options: "Thinking",
  model: "Thinking model",
  none: "No thinking",
}

function CapabilityBadges({ thinking, tools }: { thinking: ThinkingSupport | null; tools: boolean | null }) {
  return (
    <>
      <Badge variant={thinking && thinking !== "none" ? "secondary" : "outline"}>
        {thinking ? THINKING_LABELS[thinking] : "Thinking unknown"}
      </Badge>
      <Badge variant={tools ? "secondary" : "outline"}>
        {tools === null ? "Tools unknown" : tools ? "Tools" : "No tools"}
      </Badge>
    </>
  )
}

function CapabilitiesList({ provider }: { provider: LlmProvider }) {
  const capabilities = useLlmCapabilities(provider)
  if (capabilities.isPending) return <p className="text-sm text-muted-foreground">Loading...</p>
  if (capabilities.isError) return <p role="alert" className="text-sm text-destructive">Could not load capabilities</p>
  const rows = capabilities.data.capabilities
  if (!rows.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing recorded yet. Test a model, or run a review with thinking or agentic context on, to detect what it supports.
      </p>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Model</TableHead>
          <TableHead>Supports</TableHead>
          <TableHead>Checked</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.endpoint ?? ""}:${row.model}`}>
            <TableCell className="font-mono text-xs break-all whitespace-normal">{row.model}</TableCell>
            <TableCell className="whitespace-normal">
              <div className="flex flex-wrap gap-1">
                <CapabilityBadges thinking={row.thinking} tools={row.tools} />
              </div>
              {row.detail && <p className="mt-1 text-xs text-muted-foreground">{row.detail}</p>}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">
              {formatDate(row.checkedAt)} ({row.source === "probe" ? "probe" : "review"})
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function StatusRow({ apiKey }: { apiKey: ApiKey }) {
  // An unreadable key has nothing to send the provider, so it is not checked.
  const checkable = !apiKey.undecryptable
  const { status, checkedAt, isFetching, refetch } = useApiKeyStatus(apiKey.provider, { enabled: checkable })
  return (
    <>
      <DetailRow label="Status">
        <div className="flex flex-wrap items-center gap-2">
          <ConnectionStateBadge state={connectionState(apiKey, isFetching ? undefined : status)} />
          {checkable && (
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RotateCw className={cn(isFetching && "animate-spin")} />
              Check again
            </Button>
          )}
        </div>
      </DetailRow>
      {checkedAt && (
        <DetailRow label="Last checked">
          <span title={new Date(checkedAt).toLocaleString()}>{timeAgo(new Date(checkedAt).toISOString())}</span>
        </DetailRow>
      )}
    </>
  )
}

// Rendered once beside the grid for the same reason as RemoveKeyDialog. The
// test form is keyed by provider so reopening starts without the last model
// or result.
export function DetailsSheet({ apiKey, onOpenChange }: { apiKey: ApiKey | null; onOpenChange: (open: boolean) => void }) {
  const provider = apiKey ? LLM_PROVIDERS[apiKey.provider] : null

  return (
    <Sheet open={apiKey !== null} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-xl">
        {apiKey && provider && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <provider.icon className="size-4" />
                {provider.label} connection
              </SheetTitle>
              <SheetDescription className="break-all">{apiKey.baseUrl ?? "Official API"}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-4">
              <Section title="Overview">
                <dl className="grid grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-2 text-sm">
                  <StatusRow apiKey={apiKey} />
                  <DetailRow label="Key">
                    <span className="font-mono">{keyText(apiKey)}</span>
                  </DetailRow>
                  <DetailRow label="Host">{apiKey.baseUrl ?? "Default"}</DetailRow>
                  {apiKey.updatedAt && (
                    <DetailRow label="Updated">
                      <span title={new Date(apiKey.updatedAt).toLocaleString()}>{formatDate(apiKey.updatedAt)}</span>
                    </DetailRow>
                  )}
                </dl>
              </Section>
              <Separator />
              <Section title="Test a model">
                {apiKey.undecryptable ? (
                  // An unreadable key has nothing to send the provider.
                  <p className="text-sm text-muted-foreground">Replace the key to test models on this connection.</p>
                ) : (
                  <TestModelForm key={apiKey.provider} apiKey={apiKey} />
                )}
              </Section>
              <Separator />
              <Section title="Model capabilities">
                <p className="text-sm text-muted-foreground">
                  What each model was found to support on this connection. Reviews skip what is missing, with a warning.
                </p>
                <CapabilitiesList provider={apiKey.provider} />
              </Section>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
