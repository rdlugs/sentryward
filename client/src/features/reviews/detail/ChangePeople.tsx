import { GitBranch } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { timeAgo } from "@/lib/time"
import type { ForgeUser } from "../types"

// A forge account: avatar and @login, linked to its profile when the forge gave one.
export function ForgeUserLink({ user }: { user: ForgeUser }) {
  const content = (
    <>
      <Avatar aria-hidden className="size-4">
        {user.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
        <AvatarFallback className="text-[0.5rem]">{user.login.slice(0, 2).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="truncate">@{user.login}</span>
    </>
  )
  const className = "inline-flex max-w-full min-w-0 items-center gap-1 align-middle"
  return user.webUrl ? (
    <a href={user.webUrl} target="_blank" rel="noreferrer" className={`${className} hover:underline`} title={user.name}>
      {content}
    </a>
  ) : (
    <span className={className} title={user.name}>
      {content}
    </span>
  )
}

// "2 days ago", with the exact date and time on hover.
export function RelativeTime({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  )
}

// "feature → main", each name truncated with the full one on hover.
export function BranchPair({ source, target }: { source: string; target: string }) {
  return (
    <span
      aria-label={`From ${source} into ${target}`}
      className="inline-flex max-w-full min-w-0 items-center gap-1 align-middle font-mono text-xs"
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate" title={source}>
        {source}
      </span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
      <span className="truncate" title={target}>
        {target}
      </span>
    </span>
  )
}
