import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Link, useNavigate, useParams } from "react-router"
import { KeyRound, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { AuthHeader, AuthLayout } from "@/layouts/AuthLayout"
import { useAuth } from "@/features/auth/useAuth"
import { PasswordField } from "@/features/auth/PasswordField"
import { PasswordMatch, PasswordStrength } from "@/features/auth/PasswordStrength"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { usePasswordReset } from "@/features/auth/passwordReset"
import { resetPasswordSchema, type ResetPasswordInput } from "@/features/auth/schemas"

// Reachable signed in or out, like invite links: completing it signs in as the
// account the link is for and ends every other session.
export function ResetPasswordPage() {
  const { token = "" } = useParams()
  const { resetPassword } = useAuth()
  const navigate = useNavigate()
  const { data: reset, isLoading, isError } = usePasswordReset(token)
  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  })
  const [password, confirmPassword] = useWatch({ control: form.control, name: ["password", "confirmPassword"] })

  async function onSubmit(values: ResetPasswordInput) {
    try {
      await resetPassword(token, values)
      toast.success("Your password was changed")
      navigate("/home", { replace: true })
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  let title = "Set a new password"
  let description: string
  if (isLoading) {
    description = "Checking your link…"
  } else if (isError || !reset) {
    title = "Link not valid"
    description = "This reset link is invalid, was already used, or has expired."
  } else {
    description = `Choose a new password for ${reset.email}. You'll be signed out everywhere else.`
  }

  return (
    <AuthLayout>
      <AuthHeader icon={KeyRound} title={title} description={description} />
      <div>
        {isLoading && <Loader2 className="mx-auto block animate-spin text-muted-foreground" />}
        {!isLoading && !reset && (
          <FieldDescription className="text-center">
            <Link to="/forgot-password">Request a new link</Link> or <Link to="/login">log in</Link>
          </FieldDescription>
        )}
        {reset && (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
            <FieldGroup>
              <PasswordField
                control={form.control}
                name="password"
                label="New password"
                autoComplete="new-password"
                autoFocus
              >
                <PasswordStrength password={password} />
              </PasswordField>
              <PasswordField
                control={form.control}
                name="confirmPassword"
                label="Confirm new password"
                autoComplete="new-password"
              >
                {!form.formState.errors.confirmPassword && (
                  <PasswordMatch password={password} confirm={confirmPassword} />
                )}
              </PasswordField>
              <Field>
                <Button type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                  Set password
                </Button>
              </Field>
            </FieldGroup>
          </form>
        )}
      </div>
    </AuthLayout>
  )
}
