import { useEffect, useRef, useState } from "react"
import { useNavigate } from "react-router"
import { GitPullRequest, Link2, Loader2, Settings } from "lucide-react"
import { toast } from "sonner"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useRepos } from "@/features/forge/api"
import { PROVIDERS } from "@/features/forge/providers"
import { useCreateReview } from "@/features/reviews/api"
import { ApiError } from "@/lib/api"
import type { NavGroup } from "./DashboardLayout"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Already filtered for the user's role, so admin pages only show for admins.
  groups: NavGroup[]
  onStartReview: () => void
}

// Ctrl+K or Cmd+K, toggling. Unlike the findings shortcuts it also works while
// typing in a field: jumping somewhere else is what the palette is for.
function usePaletteShortcut(toggle: () => void) {
  // Read through a ref so the listener is bound once, not on every render.
  const ref = useRef(toggle)
  useEffect(() => {
    ref.current = toggle
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
      if (event.key.toLowerCase() !== "k") return
      event.preventDefault()
      ref.current()
    }
    document.addEventListener("keydown", onKeyDown)
    return () => document.removeEventListener("keydown", onKeyDown)
  }, [])
}

export function CommandPalette({ open, onOpenChange, groups, onStartReview }: Props) {
  usePaletteShortcut(() => onOpenChange(!open))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog's close button would sit on the search field; Escape closes it. */}
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg [&>button:last-child]:hidden">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <DialogDescription className="sr-only">
          Go to a page or repository, or review a pull or merge request by pasting its link.
        </DialogDescription>
        {/* Only mounted while open, so the search starts empty and repositories
            are not fetched until someone looks for one. */}
        <Palette groups={groups} onClose={() => onOpenChange(false)} onStartReview={onStartReview} />
      </DialogContent>
    </Dialog>
  )
}

function Palette({
  groups,
  onClose,
  onStartReview,
}: {
  groups: NavGroup[]
  onClose: () => void
  onStartReview: () => void
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState("")
  const repos = useRepos()
  const createReview = useCreateReview()
  const url = search.trim()
  const isUrl = /^https?:\/\/\S+$/i.test(url)

  function go(to: string) {
    onClose()
    navigate(to)
  }

  async function reviewUrl() {
    try {
      const { review } = await createReview.mutateAsync({ url })
      go(`/reviews/${review.id}`)
    } catch (err) {
      toast.error(
        err instanceof ApiError ? (err.fieldErrors?.url?.[0] ?? err.message) : "Could not queue the review",
      )
    }
  }

  return (
    <Command label="Search pages and repositories" className="rounded-none!">
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search pages and repositories, or paste a link..."
      />
      <CommandList className="max-h-96">
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup heading="Actions">
          {/* Always listed while a link is typed: the link itself is the match. */}
          {isUrl && (
            <CommandItem value={url} forceMount onSelect={reviewUrl} disabled={createReview.isPending}>
              {createReview.isPending ? <Loader2 className="animate-spin" /> : <Link2 />}
              <span className="truncate">Review {url}</span>
            </CommandItem>
          )}
          <CommandItem
            value="Start manual review"
            keywords={["pull request", "merge request", "PR", "MR"]}
            onSelect={() => {
              onClose()
              onStartReview()
            }}
          >
            <GitPullRequest />
            Start manual review
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Pages">
          {groups.flatMap((group) =>
            group.items.map((item) => (
              <CommandItem
                key={item.to}
                value={item.label}
                keywords={group.label ? [group.label] : undefined}
                onSelect={() => go(item.to)}
              >
                <item.icon />
                {item.label}
              </CommandItem>
            )),
          )}
          {/* In the user menu rather than the sidebar. */}
          <CommandItem value="Settings" keywords={["account", "profile"]} onSelect={() => go("/settings")}>
            <Settings />
            Settings
          </CommandItem>
        </CommandGroup>
        {Boolean(repos.data?.repos.length) && (
          <CommandGroup heading="Repositories">
            {repos.data!.repos.map((repo) => {
              const Icon = PROVIDERS[repo.account.provider].icon
              return (
                // The host keeps the same path on two forges apart.
                <CommandItem
                  key={repo.id}
                  value={`${repo.account.host}/${repo.fullPath}`}
                  onSelect={() => go(`/reviews?repo=${encodeURIComponent(repo.id)}`)}
                >
                  <Icon />
                  <span className="truncate">{repo.fullPath}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{repo.account.host}</span>
                </CommandItem>
              )
            })}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}
