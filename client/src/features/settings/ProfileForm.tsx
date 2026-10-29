import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { UnsavedChangesDialog } from "@/components/UnsavedChangesDialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup } from "@/components/ui/field"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes"
import type { User } from "@/features/auth/auth-context"
import { useUpdateProfile, type ProfileInput } from "./api"

const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().trim().email("Invalid email address"),
})

export function ProfileForm({ user }: { user: User }) {
  const update = useUpdateProfile()
  const form = useForm<ProfileInput>({
    resolver: zodResolver(profileSchema),
    defaultValues: { name: user.name, email: user.email },
  })
  const leaving = useUnsavedChanges(form.formState.isDirty)

  async function onSubmit(values: ProfileInput) {
    try {
      const { user } = await update.mutateAsync(values)
      form.reset({ name: user.name, email: user.email })
      toast.success("Profile updated")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <UnsavedChangesDialog open={leaving.blocked} onKeep={leaving.keep} onDiscard={leaving.discard} />
      <FieldGroup>
        <TextField control={form.control} name="name" label="Name" autoComplete="name" placeholder="Jane Doe" />
        <TextField control={form.control} name="email" label="Email" type="email" autoComplete="email" placeholder="you@example.com" />
        <Field orientation="horizontal">
          <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Save profile
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
