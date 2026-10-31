import { useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AlertTriangle, Copy, KeyRound, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { copyToClipboard } from "@/lib/clipboard"
import { formatDate, timeAgo } from "@/lib/time"
import { useApiTokens, useCreateApiToken, useRevokeApiToken, type ApiToken } from "./api"

const NEVER = "never"
const EXPIRY_OPTIONS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: NEVER, label: "No expiry" },
]

const tokenSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  expiry: z.string(),
})
type TokenInput = z.infer<typeof tokenSchema>

function isExpired(iso: string, now = Date.now()) {
  return new Date(iso).getTime() <= now
}

function Expiry({ token }: { token: ApiToken }) {
  if (!token.expiresAt) return <span className="text-muted-foreground">Never</span>
  if (isExpired(token.expiresAt)) return <Badge variant="destructive">Expired</Badge>
  return <time dateTime={token.expiresAt}>{formatDate(token.expiresAt)}</time>
}

// The value appears only here: the server keeps just a hash of it.
function CreatedTokenView({ value }: { value: string }) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Token created</DialogTitle>
        <DialogDescription>
          Copy it now and store it somewhere safe, such as your CI's secrets. It's shown only once.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input
          readOnly
          value={value}
          aria-label="API token"
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => copyToClipboard(value, "Token")}>
          <Copy />
          Copy
        </Button>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </div>
  )
}

function CreateTokenDialog() {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const createToken = useCreateApiToken()
  const form = useForm<TokenInput>({ resolver: zodResolver(tokenSchema), defaultValues: { name: "", expiry: "30" } })

  async function onSubmit({ name, expiry }: TokenInput) {
    try {
      const result = await createToken.mutateAsync({
        name,
        expiresInDays: expiry === NEVER ? null : Number(expiry),
      })
      setCreated(result.value)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      setCreated(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Create token
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <CreatedTokenView value={created} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Create an API token</DialogTitle>
              <DialogDescription>
                The token acts as you. It can read anything you can and queue reviews, but cannot change settings.
              </DialogDescription>
            </DialogHeader>
            <TextField control={form.control} name="name" label="Name" autoComplete="off" placeholder="GitHub Actions" />
            <Controller
              control={form.control}
              name="expiry"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="token-expiry">Expires</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="token-expiry" className="w-full" onBlur={field.onBlur}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {EXPIRY_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Create token
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function RevokeTokenDialog({ token, onOpenChange }: { token: ApiToken | null; onOpenChange: (open: boolean) => void }) {
  const revokeToken = useRevokeApiToken()

  async function revoke() {
    if (!token) return
    try {
      await revokeToken.mutateAsync(token.id)
      toast.success(`Revoked ${token.name}`)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the token")
    }
  }

  return (
    <Dialog open={token !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this token?</DialogTitle>
          <DialogDescription>
            Scripts using <span className="font-medium text-foreground">{token?.name}</span> stop working at once.
            This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={revoke} disabled={revokeToken.isPending}>
            {revokeToken.isPending && <Loader2 className="animate-spin" />}
            Revoke token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ApiTokens() {
  const { data: tokens, isPending, isError } = useApiTokens()
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <p className="flex-1 text-sm text-muted-foreground">
          Send a token as <code className="font-mono text-xs">Authorization: Bearer &lt;token&gt;</code>. The
          workspace header picks the workspace, as in the dashboard.
        </p>
        <CreateTokenDialog />
      </div>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load your API tokens.</AlertTitle>
        </Alert>
      ) : tokens.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>No API tokens</EmptyTitle>
            <EmptyDescription>Create one to queue reviews and read results from CI or a script.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="w-0">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.map((token) => (
              <TableRow key={token.id}>
                <TableCell className="font-medium">{token.name}</TableCell>
                <TableCell>
                  <time dateTime={token.createdAt}>{formatDate(token.createdAt)}</time>
                </TableCell>
                <TableCell>
                  {token.lastUsedAt ? (
                    <time dateTime={token.lastUsedAt} title={new Date(token.lastUsedAt).toLocaleString()}>
                      {timeAgo(token.lastUsedAt)}
                    </time>
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </TableCell>
                <TableCell>
                  <Expiry token={token} />
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={`Revoke ${token.name}`}
                    onClick={() => setRevoking(token)}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <RevokeTokenDialog token={revoking} onOpenChange={(open) => !open && setRevoking(null)} />
    </div>
  )
}
