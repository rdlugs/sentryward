import { useDeferredValue, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import { GitBranch, Loader2 } from "lucide-react"
import { toast } from "sonner"
import { SearchableSelect } from "@/components/SearchableSelect"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { useRepos, type ForgeRepo } from "@/features/forge/api"
import { PROVIDERS } from "@/features/forge/providers"
import { ApiError } from "@/lib/api"
import { matchesQuery } from "@/lib/filters"
import { timeAgo } from "@/lib/time"
import { focusInput, MAX_FOCUS, useCreateReview, useOpenChanges } from "./api"
import { changeLabel } from "./links"
import { ReviewUrlForm } from "./ReviewUrlForm"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ManualReviewSheet({ open, onOpenChange }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Manual review</SheetTitle>
          <SheetDescription>Pick a repository, then the pull or merge request to review.</SheetDescription>
        </SheetHeader>
        {/* Mounted only while open, so the repository and filter start fresh each time. */}
        {open && <RepoPicker onDone={() => onOpenChange(false)} />}
      </SheetContent>
    </Sheet>
  )
}

function RepoPicker({ onDone }: { onDone: () => void }) {
  const { data, isPending, isError } = useRepos()
  // Disabled repositories refuse manual reviews too, so they are not offered.
  const repos = useMemo(
    () => (data?.repos ?? []).filter((repo) => repo.enabled).sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [data],
  )
  const [repoId, setRepoId] = useState<string>()
  const [focus, setFocus] = useState("")
  const repo = repos.find((r) => r.id === repoId)

  return (
    <>
      <div className="px-4">
        {isPending ? (
          <Skeleton className="h-9 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">Could not load repositories.</p>
        ) : !repos.length ? (
          <p className="text-sm text-muted-foreground">
            No repositories have reviews turned on.{" "}
            <Link to="/repositories" className="underline underline-offset-4" onClick={onDone}>
              Add one under Repositories
            </Link>
            .
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor="manual-review-repo">Repository</FieldLabel>
            <SearchableSelect
              id="manual-review-repo"
              value={repoId}
              onValueChange={setRepoId}
              placeholder="Select a repository"
              searchPlaceholder="Search repositories..."
              options={repos.map((r) => ({
                value: r.id,
                label: r.fullPath,
                icon: PROVIDERS[r.account.provider].icon,
                description: r.account.host,
                keywords: [r.account.host],
              }))}
            />
          </Field>
        )}
        {/* Applies to whichever change is reviewed below, picked or pasted. */}
        <Field className="mt-4">
          <FieldLabel htmlFor="manual-review-focus">Focus (optional)</FieldLabel>
          <Input
            id="manual-review-focus"
            value={focus}
            onChange={(event) => setFocus(event.target.value)}
            maxLength={MAX_FOCUS}
            placeholder="e.g. the auth and session logic"
          />
          <FieldDescription>Looked at hardest, for this review only. Problems elsewhere are still reported.</FieldDescription>
        </Field>
      </div>
      {/* Keyed so switching repositories clears the filter. */}
      {repo ? (
        <ChangeList key={repo.id} repo={repo} focus={focus} onDone={onDone} />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
      {/* For a change Sentryward's list does not show, e.g. one past the newest few hundred. */}
      <div className="border-t p-4">
        <ReviewUrlForm onQueued={onDone} focus={focus} />
      </div>
    </>
  )
}

function ChangeList({ repo, focus, onDone }: { repo: ForgeRepo; focus: string; onDone: () => void }) {
  const { data, isPending, isError, error } = useOpenChanges(repo.id)
  const createReview = useCreateReview()
  const navigate = useNavigate()
  const [filter, setFilter] = useState("")
  const [pendingNumber, setPendingNumber] = useState<number>()
  const provider = repo.account.provider
  const noun = PROVIDERS[provider].changeNoun.toLowerCase()

  const deferredFilter = useDeferredValue(filter)
  const changes = useMemo(() => {
    return (data?.changes ?? []).filter((change) =>
      matchesQuery(
        deferredFilter,
        change.title,
        changeLabel(provider, change.number),
        String(change.number),
        change.sourceBranch,
        change.author ?? "",
      ),
    )
  }, [data, deferredFilter, provider])

  async function review(number: number) {
    setPendingNumber(number)
    try {
      const { review } = await createReview.mutateAsync({ repoId: repo.id, number, ...focusInput(focus) })
      onDone()
      navigate(`/reviews/${review.id}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not queue the review")
    } finally {
      setPendingNumber(undefined)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 px-4">
      <Input
        placeholder={`Filter ${noun}s`}
        aria-label={`Filter ${noun}s`}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border">
        {isError ? (
          <p className="p-4 text-sm text-destructive">{error.message}</p>
        ) : isPending ? (
          <ChangeListSkeleton />
        ) : !data.changes.length ? (
          <p className="p-4 text-sm text-muted-foreground">No open {noun}s in {repo.fullPath}.</p>
        ) : !changes.length ? (
          <p className="p-4 text-sm text-muted-foreground">No {noun}s match.</p>
        ) : (
          <ul className="divide-y" aria-label={`Open ${noun}s`}>
            {changes.map((change) => (
              <li key={change.number} className="flex items-center gap-3 px-3 py-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-2 text-sm">
                    <span className="shrink-0 text-muted-foreground">{changeLabel(provider, change.number)}</span>
                    <a
                      href={change.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="truncate font-medium hover:underline"
                    >
                      {change.title}
                    </a>
                    {change.isDraft && <Badge variant="outline">Draft</Badge>}
                  </div>
                  <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                    <GitBranch className="size-3 shrink-0" />
                    <span className="truncate">
                      {change.sourceBranch} → {change.targetBranch}
                    </span>
                    <span className="shrink-0">
                      {change.author && <> · {change.author}</>} · {timeAgo(change.updatedAt)}
                    </span>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => review(change.number)}
                  disabled={createReview.isPending}
                  aria-label={`Review ${changeLabel(provider, change.number)}`}
                >
                  {pendingNumber === change.number && <Loader2 className="animate-spin" />}
                  Review
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// Shaped like the rows above, so nothing jumps when the list arrives.
const SKELETON_WIDTHS = ["max-w-56", "max-w-40", "max-w-64", "max-w-48"]

function ChangeListSkeleton() {
  return (
    <ul className="divide-y" role="status" aria-label="Loading changes">
      {SKELETON_WIDTHS.map((width) => (
        <li key={width} className="flex items-center gap-3 px-3 py-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className={`h-4 ${width}`} />
            <Skeleton className="h-3 max-w-32" />
          </div>
          <Skeleton className="h-8 w-16" />
        </li>
      ))}
    </ul>
  )
}
