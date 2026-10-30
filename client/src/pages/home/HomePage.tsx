import type { ReactNode } from "react"
import { Link } from "react-router"
import { BookOpen, FolderGit2, GitPullRequest, KeyRound, SlidersHorizontal, Zap, type LucideIcon } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Card, CardContent } from "@/components/ui/card"
import { useGlobalConfig } from "@/features/config/api"
import { useConnections } from "@/features/forge/api"
import { useReviews } from "@/features/reviews/api"
import { useStartManualReview } from "@/features/reviews/useStartManualReview"
import { ConnectionsPanel } from "./ConnectionsPanel"
import { HomeMetrics } from "./HomeMetrics"
import { RecentReviewsTimeline } from "./RecentReviewsTimeline"
import { SetupChecklist } from "./SetupChecklist"
import { useSetupProgress } from "./useSetupProgress"

const DOCS_URL = "https://github.com/rdlugs/sentryward#readme"

function IconTile({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/50">
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="text-sm font-medium text-muted-foreground">{children}</h2>
}

function CodebaseCard({ icon, title, text, link }: { icon: LucideIcon; title: string; text: string; link: { label: string; to: string } }) {
  return (
    <Card className="bg-muted/30">
      <CardContent className="flex h-full flex-col items-start gap-4">
        <IconTile icon={icon} />
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-sm text-muted-foreground">{text}</p>
        </div>
        <Link to={link.to} className="mt-auto text-sm font-medium hover:underline">
          {link.label}
        </Link>
      </CardContent>
    </Card>
  )
}

const actionRow =
  "flex w-full items-center gap-4 rounded-xl border bg-card px-6 py-4 text-left transition-colors hover:bg-accent/50 compact:px-4 compact:py-3 spacious:px-8 spacious:py-5"

function ActionText({ title, text }: { title: string; text: string }) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm text-muted-foreground">{text}</span>
    </span>
  )
}

function plural(count: number, noun: string, nouns = `${noun}s`) {
  return `${count} ${count === 1 ? noun : nouns}`
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function HomePage() {
  const startReview = useStartManualReview()
  const connections = useConnections().data?.connections ?? []
  const config = useGlobalConfig().data?.config
  const setup = useSetupProgress()
  // Same query as the recent reviews timeline. Any run counts, failed ones
  // included, since failures are one of the figures; nothing shows until it
  // loads, so a new workspace never flashes empty tiles.
  const anyReviews = (useReviews({ limit: 5 }).data?.total ?? 0) > 0

  const { enabledRepos } = setup
  const blockOn = config?.review.blockOn
  const configText = config
    ? `${capitalize(config.profile)} profile, blocks on ${blockOn === "critical" ? "critical" : `${blockOn} or worse`} findings.`
    : "Choose what reviews look for and when they block."
  // Setup steps live in the checklist, so these are only what applies once
  // each is done: a provider outage, reviewing again, and turning on
  // automatic reviews.
  const showUnreachable = !setup.isPending && setup.llmUnreachable
  const showReview = !setup.isPending && setup.hasReviews
  const showAutomatic = !setup.isPending && setup.complete && setup.manualOnly

  return (
    <PageShell variant="wide">
      <PageHeader title="Overview" description="Your review setup at a glance, and what to do next." />
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_20rem] compact:gap-8 spacious:gap-12">
        <div className="flex flex-col gap-8 compact:gap-6 spacious:gap-10">
          {anyReviews && <HomeMetrics />}
          <SetupChecklist steps={setup.steps} isPending={setup.isPending} onReview={startReview} />

          <section className="flex flex-col gap-4 compact:gap-3 spacious:gap-5">
            <SectionLabel>From your codebase</SectionLabel>
            <div className="grid gap-4 sm:grid-cols-2">
              <CodebaseCard
                icon={FolderGit2}
                title="Repositories"
                text={
                  enabledRepos === 0
                    ? "No repositories enabled yet."
                    : `${plural(enabledRepos, "repository", "repositories")} enabled across ${plural(connections.length, "connection")}.`
                }
                link={{ label: "Manage repositories", to: "/repositories" }}
              />
              <CodebaseCard
                icon={SlidersHorizontal}
                title="Review configuration"
                text={configText}
                link={{ label: "Configure reviews", to: "/configuration" }}
              />
            </div>
          </section>

          {(showUnreachable || showReview || showAutomatic) && (
            <section className="flex flex-col gap-3 compact:gap-2 spacious:gap-4">
              <SectionLabel>Suggested actions</SectionLabel>
              {showUnreachable && (
                <Link to="/llm-connections" className={actionRow}>
                  <IconTile icon={KeyRound} />
                  <ActionText
                    title="Can't reach your LLM provider"
                    text="The provider didn't answer its status check, so reviews may fail until it's reachable again."
                  />
                </Link>
              )}
              {showReview && (
                <button type="button" className={actionRow} onClick={startReview}>
                  <IconTile icon={GitPullRequest} />
                  <ActionText title="Review a change" text="Pick an open pull request or paste a link to review it now." />
                </button>
              )}
              {showAutomatic && (
                <Link to="/configuration" className={actionRow}>
                  <IconTile icon={Zap} />
                  <ActionText
                    title="Turn on automatic reviews"
                    text="Only reviews you request run now. Review pull requests as they're opened or updated."
                  />
                </Link>
              )}
            </section>
          )}
        </div>

        <aside className="flex flex-col gap-5">
          <ConnectionsPanel />
          <RecentReviewsTimeline />
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-3 rounded-md py-1 text-sm transition-colors hover:text-muted-foreground"
          >
            <IconTile icon={BookOpen} />
            Documentation
          </a>
        </aside>
      </div>
    </PageShell>
  )
}
