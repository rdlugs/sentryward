import type { ReactNode } from "react"
import { GitPullRequest, MessageSquareCode, ServerCog, type LucideIcon } from "lucide-react"
import { ModeToggle } from "@/components/mode-toggle"
import { WaveformBackground } from "@/features/auth/WaveformBackground"
import { ReviewDemo } from "@/features/auth/ReviewDemo"

const highlights: { icon: LucideIcon; title: string; description: string }[] = [
  {
    icon: MessageSquareCode,
    title: "Findings where the code is",
    description: "Inline comments with suggested fixes, a summary and a commit status on every change.",
  },
  {
    icon: GitPullRequest,
    title: "GitHub and GitLab",
    description: "Review pull and merge requests on push, on demand, or from a comment.",
  },
  {
    icon: ServerCog,
    title: "Yours to run",
    description: "Self-hosted, with your own model keys and a .sentryward.yaml per repository.",
  },
]

function Brand() {
  return (
    <div className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
      <img src="/sentryward-192.png" alt="" className="size-8" />
      Sentryward
    </div>
  )
}

// The brand panel follows the app theme; in light mode it gets a tinted surface
// and a divider so it stays distinct from the white form side. It only appears
// once there is room for two columns. Its content is `relative` so it paints
// above the waveform canvas.
function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden border-r bg-muted/40 p-10 text-foreground lg:flex dark:bg-background">
      <WaveformBackground />
      <div className="pointer-events-none absolute -top-40 -right-40 size-[32rem] rounded-full bg-chart-1/15 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-48 -left-32 size-[28rem] rounded-full bg-chart-3/10 blur-3xl" />
      <div className="relative">
        <Brand />
      </div>
      <div className="relative flex max-w-md flex-col gap-8">
        <div className="flex flex-col gap-3">
          <h2 className="text-3xl font-semibold tracking-tight text-balance">
            AI code review on the model you choose
          </h2>
          <p className="text-muted-foreground">
            Bring your own Anthropic, OpenAI or Google key, a compatible proxy, or a local Ollama model.
            Sentryward catches bugs, risky changes and missing tests in every pull and merge request.
          </p>
        </div>
        <ReviewDemo />
        <ul className="flex flex-wrap gap-x-5 gap-y-2">
          {highlights.map(({ icon: Icon, title, description }) => (
            <li key={title} title={description} className="flex items-center gap-2 text-sm text-muted-foreground">
              <Icon className="size-4 text-foreground" />
              {title}
            </li>
          ))}
        </ul>
      </div>
      <p className="relative text-xs text-muted-foreground">Open source and self-hosted.</p>
    </aside>
  )
}

export function AuthHeader({ icon: Icon, title, description }: { icon?: LucideIcon; title: string; description?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {Icon && (
        <div className="mb-2 flex size-10 items-center justify-center rounded-lg border bg-muted">
          <Icon className="size-5" />
        </div>
      )}
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description && <p className="text-sm text-balance text-muted-foreground">{description}</p>}
    </div>
  )
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      <BrandPanel />
      <main className="relative flex flex-col items-center justify-center bg-dots p-6 md:p-10">
        <div className="absolute top-4 right-4">
          <ModeToggle />
        </div>
        <div className="flex w-full max-w-sm flex-col gap-8">
          <div className="lg:hidden">
            <Brand />
          </div>
          {children}
        </div>
      </main>
    </div>
  )
}
