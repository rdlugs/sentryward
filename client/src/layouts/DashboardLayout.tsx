import { Suspense, useState } from "react"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router"
import {
  Bell,
  Bug,
  ChevronRight,
  ChevronsUpDown,
  Coins,
  FolderGit2,
  Gauge,
  GitPullRequest,
  House,
  KeyRound,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react"
import { toast } from "sonner"
import { ChunkLoadError } from "@/components/ChunkLoadError"
import { DensityToggle } from "@/components/density-toggle"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { ModeToggle } from "@/components/mode-toggle"
import { UserAvatar } from "@/components/UserAvatar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { FullPageSpinner } from "@/features/auth/FullPageSpinner"
import { useAuth } from "@/features/auth/useAuth"
import { ManualReviewProvider } from "@/features/reviews/ManualReviewProvider"
import { useStartManualReview } from "@/features/reviews/useStartManualReview"
import { WorkspaceSwitcher } from "@/features/workspaces/WorkspaceSwitcher"
import { isMac } from "@/lib/platform"
import { CommandPalette } from "./CommandPalette"
import { useNavAttention, type NavAttention } from "./useNavAttention"

export type NavItem = { to: string; label: string; icon: typeof House }
export type NavGroup = { label?: string; adminOnly?: boolean; items: NavItem[] }

// Grouped by what you come to do: follow reviews, read the numbers, set the
// workspace up (in the order a new workspace needs it), run the instance.
// Administration is for instance admins only; the API enforces the same rule.
// The current team is managed from the workspace switcher, not from here.
const NAV_GROUPS: NavGroup[] = [
  { items: [{ to: "/home", label: "Home", icon: House }] },
  {
    label: "Activity",
    items: [
      { to: "/reviews", label: "Reviews", icon: GitPullRequest },
      { to: "/findings", label: "Findings", icon: Bug },
    ],
  },
  {
    label: "Insights",
    items: [
      { to: "/usage", label: "Usage", icon: Coins },
      { to: "/benchmarks", label: "Benchmarks", icon: Gauge },
    ],
  },
  {
    label: "Workspace",
    items: [
      { to: "/repositories", label: "Repositories", icon: FolderGit2 },
      { to: "/llm-connections", label: "LLM Connections", icon: KeyRound },
      { to: "/configuration", label: "Review settings", icon: SlidersHorizontal },
      { to: "/notifications", label: "Notifications", icon: Bell },
      { to: "/privacy", label: "Privacy", icon: ShieldCheck },
    ],
  },
  {
    label: "Administration",
    adminOnly: true,
    items: [
      { to: "/admin/users", label: "Users", icon: Users },
      { to: "/admin/settings", label: "Instance settings", icon: Settings },
    ],
  },
]

// The top bar's hint for the palette: Cmd+K on macOS, Ctrl+K elsewhere.
function paletteShortcut() {
  return isMac() ? { label: "⌘K", aria: "Meta+K" } : { label: "Ctrl K", aria: "Control+K" }
}

// Where you are, for the top bar; each page renders its own h1. Groups have no
// page of their own, so they are plain text rather than links.
function breadcrumb(pathname: string): { label: string; to?: string }[] {
  if (pathname.startsWith("/reviews/"))
    return [{ label: "Activity" }, { label: "Reviews", to: "/reviews" }, { label: "Review" }]
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }]
  if (pathname.startsWith("/workspace")) return [{ label: "Team" }]
  for (const group of NAV_GROUPS) {
    const item = group.items.find((entry) => pathname.startsWith(entry.to))
    if (item) return group.label ? [{ label: group.label }, { label: item.label }] : [{ label: item.label }]
  }
  return [{ label: "Home" }]
}

function NavItems({
  items,
  pathname,
  attention,
}: {
  items: NavItem[]
  pathname: string
  attention: Record<string, NavAttention | undefined>
}) {
  return (
    <SidebarMenu>
      {items.map((item) => {
        const flag = attention[item.to]
        return (
          <SidebarMenuItem key={item.to}>
            <SidebarMenuButton
              asChild
              isActive={pathname.startsWith(item.to)}
              tooltip={flag ? `${item.label}: ${flag.label}` : item.label}
              // Room for the badge, as the button keeps for a menu action.
              className={flag ? "pr-8" : undefined}
            >
              <NavLink to={item.to}>
                {/* The badge hides with the labels, so a collapsed sidebar
                    keeps a dot on the icon. */}
                <span className="relative flex shrink-0">
                  <item.icon className="size-4" />
                  {flag && (
                    <span
                      className="absolute -top-1 -right-1 hidden size-2 rounded-full bg-destructive group-data-[collapsible=icon]:block"
                      aria-hidden
                    />
                  )}
                </span>
                {/* The flag's text is part of the link's name, so it is read
                    with the item; nested so the label stays the last span the
                    button truncates. */}
                <span>
                  {item.label}
                  {flag && <span className="sr-only">, {flag.label}</span>}
                </span>
              </NavLink>
            </SidebarMenuButton>
            {flag && (
              <SidebarMenuBadge aria-hidden className="text-destructive">
                {flag.count ?? <span className="size-2 rounded-full bg-destructive" />}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

function ReviewButton() {
  const startReview = useStartManualReview()
  return (
    <Button size="sm" onClick={startReview} aria-label="Review a PR">
      <GitPullRequest />
      <span className="hidden sm:inline">Review a PR</span>
    </Button>
  )
}

export function DashboardLayout() {
  const { user, workspace, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const attention = useNavAttention(pathname)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const shortcut = paletteShortcut()

  async function handleLogout() {
    try {
      await logout()
      navigate("/login", { replace: true })
    } catch {
      toast.error("Could not log out, please try again")
    }
  }

  if (!user) {
    return null
  }
  const groups = NAV_GROUPS.filter((group) => !group.adminOnly || user.role === "admin")

  return (
    // Here rather than on a page, so a manual review can be started from anywhere.
    <ManualReviewProvider>
      <SidebarProvider>
        <Sidebar collapsible="icon">
          <SidebarHeader>
            <WorkspaceSwitcher />
          </SidebarHeader>
          <SidebarContent>
            {/* Collapsed to icons the labels hide, leaving the groups as
                spaced clusters. */}
            {groups.map((group) => (
              <SidebarGroup key={group.label ?? "main"}>
                {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
                <NavItems items={group.items} pathname={pathname} attention={attention} />
              </SidebarGroup>
            ))}
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton
                      size="lg"
                      className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                    >
                      <UserAvatar user={user} className="size-8 rounded-lg after:rounded-lg" fallbackClassName="rounded-lg" />
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">{user.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="min-w-56">
                    <DropdownMenuLabel className="font-normal">
                      <div className="grid text-sm leading-tight">
                        <span className="truncate font-medium">{user.name}</span>
                        <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                      </div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild>
                      <Link to="/settings">
                        <Settings />
                        Settings
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={handleLogout}>
                      <LogOut />
                      Log out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        {/* min-w-0 lets wide content (code blocks, tables) scroll inside the
            page instead of stretching the whole layout past the viewport. */}
        <SidebarInset className="min-w-0 bg-dots">
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80 lg:px-6">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
            <nav aria-label="Breadcrumb" className="min-w-0">
              <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
                {breadcrumb(pathname).map((crumb, i) => (
                  <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
                    {i > 0 && <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
                    {crumb.to ? (
                      <Link to={crumb.to} className="transition-colors hover:text-foreground">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current="page" className="truncate font-medium text-foreground">
                        {crumb.label}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </nav>
            <div className="ml-auto flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search"
                aria-keyshortcuts={shortcut.aria}
              >
                <Search />
                <span className="hidden sm:inline">Search</span>
                <kbd className="ml-2 hidden rounded border bg-muted px-1 font-mono text-[0.7rem] sm:inline">
                  {shortcut.label}
                </kbd>
              </Button>
              <ReviewButton />
              <DensityToggle />
              <ModeToggle />
            </div>
          </header>
          {/* Pages are lazy (see App.tsx); these boundaries keep the sidebar and
              top bar up while a page's chunk loads or if it fails to. Keying the
              error boundary on the path clears a failure once you navigate away.
              Remounting on a switch resets page state along with the cleared cache. */}
          <ErrorBoundary key={pathname} fallback={<ChunkLoadError className="min-h-0 flex-1 py-24" />}>
            <Suspense fallback={<FullPageSpinner className="min-h-0 flex-1 py-24" />}>
              <Outlet key={workspace?.id} />
            </Suspense>
          </ErrorBoundary>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} groups={groups} />
        </SidebarInset>
      </SidebarProvider>
    </ManualReviewProvider>
  )
}
