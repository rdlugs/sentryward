import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ChevronRight, ExternalLink, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useSaveApiKey, type ApiKey, type LlmProvider } from "./api"
import { LLM_PROVIDERS } from "./providers"

type KeyInput = { apiKey: string; baseUrl: string }

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function keySchema(provider: LlmProvider, customHost: boolean) {
  return z
    .object({ apiKey: z.string().trim().max(500), baseUrl: z.string().trim().max(500) })
    .superRefine((value, context) => {
      if (provider !== "ollama" && value.apiKey.length < 8) {
        context.addIssue({ code: "custom", path: ["apiKey"], message: "That does not look like an API key" })
      }
      if (customHost && !isHttpUrl(value.baseUrl)) {
        context.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter an http or https URL" })
      }
    })
}

function KeyForm({ credential, onSaved }: { credential: ApiKey; onSaved: () => void }) {
  const save = useSaveApiKey()
  const provider = LLM_PROVIDERS[credential.provider]
  const ollama = credential.provider === "ollama"
  const [customHost, setCustomHost] = useState(ollama || Boolean(credential.baseUrl))
  const [advanced, setAdvanced] = useState(false)
  const form = useForm<KeyInput>({
    resolver: zodResolver(keySchema(credential.provider, customHost)),
    defaultValues: {
      apiKey: "",
      baseUrl: credential.baseUrl ?? provider.defaultBaseUrl ?? "",
    },
  })

  async function onSubmit(values: KeyInput) {
    try {
      await save.mutateAsync({
        provider: credential.provider,
        apiKey: values.apiKey.trim() || undefined,
        baseUrl: customHost ? values.baseUrl.trim() : undefined,
      })
      toast.success(`${provider.label} connection verified and saved`)
      onSaved()
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  const baseUrlField = (
    <TextField
      control={form.control}
      name="baseUrl"
      label="API base URL"
      type="url"
      placeholder={provider.defaultBaseUrl ?? "https://api.example.com/v1"}
    />
  )
  const apiKeyField = (
    <TextField
      control={form.control}
      name="apiKey"
      label={`${provider.label} API key${ollama ? " (optional)" : ""}`}
      type="password"
      autoComplete="off"
      placeholder={provider.keyPlaceholder}
    />
  )

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
      {ollama ? (
        // The host is the connection for Ollama, so it leads and is always shown.
        <FieldGroup>
          {baseUrlField}
          <FieldDescription>
            From Docker, use <code>host.docker.internal</code> for Ollama running on this machine.
          </FieldDescription>
          {apiKeyField}
        </FieldGroup>
      ) : (
        <FieldGroup>
          {apiKeyField}
          {/* Held open while a custom host is on, so its URL (and any error on
              it) never sits hidden in a closed section. */}
          <Collapsible open={advanced || customHost} onOpenChange={setAdvanced}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="group -ml-2.5 self-start">
                <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                Advanced
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-4 pt-3">
              <Field orientation="horizontal">
                <FieldLabel htmlFor="custom-host">Use custom host</FieldLabel>
                <Switch id="custom-host" checked={customHost} onCheckedChange={setCustomHost} aria-label="Use custom host" />
              </Field>
              {customHost && baseUrlField}
            </CollapsibleContent>
          </Collapsible>
        </FieldGroup>
      )}
      <div className="flex flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Sentryward sends one request to the provider to check the connection before saving it.
        </p>
        <Button type="submit" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
          {form.formState.isSubmitting
            ? "Checking connection..."
            : credential.stored
              ? "Check and replace"
              : "Check and save"}
        </Button>
      </div>
    </form>
  )
}

function sheetTitle(credential: ApiKey) {
  const { label } = LLM_PROVIDERS[credential.provider]
  if (credential.stored) return credential.provider === "ollama" ? "Update Ollama connection" : `Replace ${label} key`
  return credential.serverDefault ? `Use your own ${label} key` : `Connect ${label}`
}

function storedNote(credential: ApiKey) {
  if (credential.stored) {
    if (credential.undecryptable) {
      return "The stored key can't be decrypted (the server's encryption key changed). Saving replaces it."
    }
    return credential.last4
      ? `A key ending in ${credential.last4} is stored. Saving replaces it.`
      : "A host without an API key is stored. Saving replaces it."
  }
  return credential.serverDefault ? "Reviews currently use the server's key." : null
}

// One provider at a time: the card it was opened from decides which, so there
// is no provider picker. The parent keys it by provider so each open starts
// from that provider's stored host.
export function KeySheet({
  credential,
  open,
  onOpenChange,
}: {
  credential: ApiKey | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const provider = credential ? LLM_PROVIDERS[credential.provider] : null
  const note = credential ? storedNote(credential) : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-lg">
        {credential && provider && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <provider.icon className="size-4" />
                {sheetTitle(credential)}
              </SheetTitle>
              <SheetDescription>Keys are encrypted at rest.</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-6 px-4 pb-4">
              <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                <p>
                  {provider.keyUrl ? (
                    <>
                      Create a key at{" "}
                      <a
                        href={`https://${provider.keyUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-foreground underline underline-offset-4"
                      >
                        {provider.keyUrl}
                        <ExternalLink className="size-3.5" />
                      </a>
                      .
                    </>
                  ) : (
                    "Connect to an Ollama server that exposes its OpenAI-compatible API."
                  )}
                </p>
                {note && <p>{note}</p>}
              </div>
              <KeyForm credential={credential} onSaved={() => onOpenChange(false)} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
