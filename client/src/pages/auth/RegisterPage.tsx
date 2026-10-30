import { useState } from "react"
import { useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Link, useNavigate, useSearchParams } from "react-router"
import { Loader2, Lock, Mail, ShieldCheck, User, UserPlus, type LucideIcon } from "lucide-react"
import { toast } from "sonner"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field"
import { AuthHeader, AuthLayout } from "@/layouts/AuthLayout"
import { useAuth } from "@/features/auth/useAuth"
import { TextField } from "@/features/auth/TextField"
import { PasswordField } from "@/features/auth/PasswordField"
import { PasswordMatch, PasswordStrength } from "@/features/auth/PasswordStrength"
import { FormAlert } from "@/features/auth/FormAlert"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { registerSchema, type RegisterInput } from "@/features/auth/schemas"
import { useRegistration } from "@/features/auth/registration"

function RegistrationUnavailable({ icon, title, description }: { icon: LucideIcon; title: string; description: string }) {
  return (
    <AuthLayout>
      <AuthHeader icon={icon} title={title} description={description} />
      <FieldDescription className="text-center">
        Already have an account? <Link to="/login">Log in</Link>
      </FieldDescription>
    </AuthLayout>
  )
}

export function RegisterPage() {
  const { register } = useAuth()
  const navigate = useNavigate()
  // Set by the invite page; the server checks it, this page only passes it on.
  const inviteToken = useSearchParams()[0].get("invite") ?? undefined
  // The form stays usable while this loads or if it fails: the server enforces
  // the mode either way, this only explains it up front.
  const { data: registration } = useRegistration()
  const [formError, setFormError] = useState<string | null>(null)

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "", confirmPassword: "", inviteToken },
  })
  const [password, confirmPassword] = useWatch({ control: form.control, name: ["password", "confirmPassword"] })

  async function onSubmit(values: RegisterInput) {
    setFormError(null)
    try {
      const user = await register(values)
      toast.success(`Welcome, ${user.name}!`)
      navigate("/home", { replace: true })
    } catch (error) {
      applyServerErrors(error, form.setError, setFormError)
    }
  }

  if (registration && !registration.firstUser) {
    if (registration.mode === "closed") {
      return (
        <RegistrationUnavailable
          icon={Lock}
          title="Registration is closed"
          description="This Sentryward instance is not accepting new accounts. Ask an admin for access."
        />
      )
    }
    if (registration.mode === "invite" && !inviteToken) {
      return (
        <RegistrationUnavailable
          icon={Mail}
          title="Invite required"
          description="Accounts on this Sentryward instance are created from invite links. Ask an admin to invite you."
        />
      )
    }
  }

  return (
    <AuthLayout>
      <AuthHeader icon={UserPlus} title="Create an account" description="Get started with Sentryward" />
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <FieldGroup>
          <FormAlert message={formError} />
          {registration?.firstUser && (
            <Alert>
              <ShieldCheck />
              <AlertDescription>You are the first user, so you will be this instance's admin.</AlertDescription>
            </Alert>
          )}
          <TextField
            control={form.control}
            name="name"
            label="Name"
            autoComplete="name"
            autoFocus
            placeholder="Jane Doe"
            icon={User}
          />
          <TextField
            control={form.control}
            name="email"
            label="Email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            icon={Mail}
          />
          <PasswordField
            control={form.control}
            name="password"
            label="Password"
            autoComplete="new-password"
          >
            <PasswordStrength password={password} />
          </PasswordField>
          <PasswordField
            control={form.control}
            name="confirmPassword"
            label="Confirm password"
            autoComplete="new-password"
          >
            {!form.formState.errors.confirmPassword && <PasswordMatch password={password} confirm={confirmPassword} />}
          </PasswordField>
          <Field>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Create account
            </Button>
            <FieldDescription className="text-center">
              Already have an account? <Link to="/login">Log in</Link>
            </FieldDescription>
          </Field>
        </FieldGroup>
      </form>
    </AuthLayout>
  )
}
