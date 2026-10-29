import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import { useApiKeys } from "@/features/llm-connections/api"
import { useConfigSchema, useRulePatternErrors, useSaveGlobalConfig, type ConfigOverride, type GlobalConfig } from "./api"
import { ConfigFields } from "./ConfigFields"
import { SaveBar } from "./SaveBar"
import type { ConfigTab } from "./tabs"
import {
  INHERIT,
  baseConfig,
  isDirty,
  toForm,
  toSettings,
  validateForm,
  withoutDefaults,
  type FormState,
} from "./settingsForm"

// Rendered once the global config has loaded, so the form starts from it.
export function GlobalConfigForm(props: {
  global: GlobalConfig
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
}) {
  const { global } = props
  const save = useSaveGlobalConfig()
  const schema = useConfigSchema()
  const apiKeys = useApiKeys()
  const [form, setForm] = useState<FormState>(() => toForm(global.settings))
  // Fields left unset show what the selected profile and the defaults give.
  const inherited = schema.data && baseConfig(schema.data, form.profile === INHERIT ? undefined : form.profile)
  const finish = (settings: ConfigOverride) => (schema.data ? withoutDefaults(settings, schema.data) : settings)
  const dirty = isDirty(global.settings, form, finish)
  const leaving = useUnsavedChanges(dirty, ["repo"])
  const patternErrors = useRulePatternErrors(form.rules.map((rule) => rule.pattern)).data
  const errors = validateForm(
    form,
    true,
    apiKeys.data?.keys.filter((key) => key.stored).map((key) => key.provider),
    patternErrors,
  )
  const valid = Object.keys(errors).length === 0
  const resetSettings: ConfigOverride =
    form.connection === INHERIT
      ? {}
      : { llm: { connection: form.connection as "anthropic" | "openai" | "google" | "ollama" } }
  const canReset = JSON.stringify(global.settings) !== JSON.stringify(resetSettings)

  async function submit(settings: GlobalConfig["settings"], message: string) {
    try {
      const saved = await save.mutateAsync(settings)
      setForm(toForm(saved.settings))
      toast.success(message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the global config")
    }
  }

  return (
    <>
      <UnsavedChangesDialog open={leaving.blocked} onKeep={leaving.keep} onDiscard={leaving.discard} />
      <ConfigFields
        mode="global"
        form={form}
        onChange={setForm}
        tab={props.tab}
        onTabChange={props.onTabChange}
        config={global.config}
        sources={global.sources}
        inherited={inherited}
        errors={errors}
        rulePatternErrors={patternErrors}
        notices={
          global.warnings.length > 0 && (
            <Alert>
              <AlertDescription>
                {global.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </AlertDescription>
            </Alert>
          )
        }
        footer={
          <SaveBar dirty={dirty} onDiscard={() => setForm(toForm(global.settings))} disabled={save.isPending}>
            <Button
              onClick={() => submit(finish(toSettings(global.settings, form)), "Global config saved")}
              disabled={save.isPending || !dirty || !valid}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              Save global config
            </Button>
            <Button
              variant="outline"
              onClick={() => submit(resetSettings, "Global config reset")}
              disabled={save.isPending || form.connection === INHERIT || !canReset}
            >
              Reset to defaults
            </Button>
          </SaveBar>
        }
      />
    </>
  )
}
