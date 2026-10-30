import type { ReactNode } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Link } from "react-router"
import { KeyRound, Loader2, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { AuthHeader, AuthLayout } from "@/layouts/AuthLayout"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useRequestPasswordReset } from "@/features/auth/passwordReset"
import { useRegistration } from "@/features/auth/registration"
import { forgotPasswordSchema, type ForgotPasswordInput } from "@/features/auth/schemas"

export function ForgotPasswordPage() {
  const { data: registration, isLoading } = useRegistration()
  const request = useRequestPasswordReset()
  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: "" },
  })

  async function onSubmit({ email }: ForgotPasswordInput) {
    try {
      await request.mutateAsync(email)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  const backToLogin = (
    <FieldDescription className="text-center">
      Remembered it? <Link to="/login">Log in</Link>
    </FieldDescription>
  )

  let description: string
  let content: ReactNode
  if (isLoading) {
    description = "Checking how this server can help…"
    content = <Loader2 className="mx-auto animate-spin text-muted-foreground" />
  } else if (!registration?.mailConfigured) {
    // Without mail there is no way to prove who owns the account, so an admin
    // creates the link from the Admin page and hands it over.
    description = "This server can't send email, so an admin has to help."
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Ask a Sentryward admin to create a password reset link for your account from the Admin page. The link
          works once and expires after 24 hours.
        </p>
        {backToLogin}
      </div>
    )
  } else if (request.isSuccess) {
    description = "Check your email."
    content = (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          If an account exists for {form.getValues("email")}, we've sent it a link to set a new password. The link
          works once and expires in 1 hour.
        </p>
        {backToLogin}
      </div>
    )
  } else {
    description = "Enter your account's email and we'll send you a link to set a new password."
    content = (
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <TextField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            autoFocus
            placeholder="you@example.com"
            icon={Mail}
          />
          <Field>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Send reset link
            </Button>
            {backToLogin}
          </Field>
        </FieldGroup>
      </form>
    )
  }

  return (
    <AuthLayout>
      <AuthHeader icon={KeyRound} title="Reset your password" description={description} />
      {content}
    </AuthLayout>
  )
}
