import { Link, useNavigate, useParams } from "react-router"
import { Loader2, MailOpen } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { FieldDescription, FieldError } from "@/components/ui/field"
import { AuthHeader, AuthLayout } from "@/layouts/AuthLayout"
import { useAuth } from "@/features/auth/useAuth"
import { useAcceptInvite, useInvite } from "@/features/auth/registration"

export function InvitePage() {
  const { token = "" } = useParams()
  const { user, switchWorkspace } = useAuth()
  const navigate = useNavigate()
  const { data: invite, isLoading, isError } = useInvite(token)
  const accept = useAcceptInvite(token)

  const team = invite?.workspace ?? null
  let title = "You're invited to Sentryward"
  let description: string
  if (isLoading) {
    description = "Checking your invite…"
  } else if (isError || !invite) {
    title = "Invite not valid"
    description = "This invite link is invalid, was already used, or has expired. Ask an admin for a new one."
  } else {
    const from = invite.invitedBy ? `${invite.invitedBy.name} invited you` : "You were invited"
    if (team) {
      title = `Join ${team.name}`
      const as = invite.role === "admin" ? " as an admin" : ""
      description = invite.email
        ? `${from} to join the ${team.name} team${as}, as ${invite.email}.`
        : `${from} to join the ${team.name} team${as}.`
    } else {
      description = invite.email ? `${from} to create an account as ${invite.email}.` : `${from} to create an account.`
    }
  }

  async function join() {
    try {
      const workspace = await accept.mutateAsync()
      switchWorkspace(workspace.id)
      toast.success(`You joined ${workspace.name}`)
      navigate("/home", { replace: true })
    } catch {
      // Shown below: the server's message says what went wrong.
    }
  }

  // A team invite brings you back here after logging in, to accept it with
  // the existing account.
  const loginLink = (
    <Link to="/login" state={team ? { from: `/invite/${token}` } : undefined}>
      Log in
    </Link>
  )

  return (
    <AuthLayout>
      <AuthHeader icon={MailOpen} title={title} description={description} />
      <div className="flex flex-col gap-4">
        {isLoading && <Loader2 className="mx-auto animate-spin text-muted-foreground" />}
        {invite &&
          (user ? (
            team ? (
              <>
                <Button onClick={join} disabled={accept.isPending}>
                  {accept.isPending && <Loader2 className="animate-spin" />}
                  Join {team.name}
                </Button>
                {accept.error && <FieldError className="text-center">{accept.error.message}</FieldError>}
                <FieldDescription className="text-center">
                  You're signed in as {user.email}. <Link to="/home">Not now</Link>
                </FieldDescription>
              </>
            ) : (
              <FieldDescription className="text-center">
                You're signed in as {user.email}. Log out first to create a new account with this invite.
              </FieldDescription>
            )
          ) : (
            <Button asChild>
              <Link to={`/register?invite=${encodeURIComponent(token)}`}>Create account</Link>
            </Button>
          ))}
        {!user && (
          <FieldDescription className="text-center">
            Already have an account? {loginLink}
            {team && " to join with it."}
          </FieldDescription>
        )}
      </div>
    </AuthLayout>
  )
}
