import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Link, useLocation, useNavigate } from "react-router"
import { Loader2, Mail } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { AuthHeader, AuthLayout } from "@/layouts/AuthLayout"
import { useAuth } from "@/features/auth/useAuth"
import { TextField } from "@/features/auth/TextField"
import { PasswordField } from "@/features/auth/PasswordField"
import { FormAlert } from "@/features/auth/FormAlert"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { loginSchema, type LoginInput } from "@/features/auth/schemas"
import { useRegistration } from "@/features/auth/registration"

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? "/home"
  const { data: registration } = useRegistration()
  // Only offer sign-up when /register would show the form: invitees arrive via
  // their invite link, and hiding it until the mode is known avoids a flash.
  const canSignUp = registration && (registration.firstUser || registration.mode === "open")
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(values: LoginInput) {
    setFormError(null)
    try {
      await login(values)
      navigate(from, { replace: true })
    } catch (error) {
      applyServerErrors(error, form.setError, setFormError)
    }
  }

  return (
    <AuthLayout>
      <AuthHeader title="Welcome back" description="Log in to your Sentryward account" />
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <FormAlert message={formError} />
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
          <PasswordField
            control={form.control}
            name="password"
            label="Password"
            autoComplete="current-password"
          />
          <Link to="/forgot-password" className="-mt-3 self-end text-sm text-muted-foreground underline-offset-4 hover:underline">
            Forgot password?
          </Link>
          <Field>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Log in
            </Button>
            {canSignUp && (
              <FieldDescription className="text-center">
                Don&apos;t have an account? <Link to="/register">Sign up</Link>
              </FieldDescription>
            )}
          </Field>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}
