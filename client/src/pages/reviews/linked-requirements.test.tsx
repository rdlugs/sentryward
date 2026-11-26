import { describe, expect, it, vi } from "vitest"
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { findingPrompt } from "@/features/reviews/agentPrompt"
import { mockApi } from "@/test/apiRoutes"
import { detail, result } from "@/test/fixtures"
import { renderWithProviders } from "@/test/renderWithProviders"

vi.mock("@/components/MermaidDiagram", () => ({
  MermaidDiagram: () => <div>Sequence diagram content</div>,
}))

// A requirement gap the walkthrough could place in no changed file.
const gap = {
  ...result.findings[0],
  fingerprint: "gap0000000000001",
  file: "",
  startLine: 1,
  endLine: 1,
  severity: "major" as const,
  kind: "requirement_gap" as const,
  bucket: "requirement_gap" as const,
  title: "#10: Log each export",
  body: "#10 (Original request) asks for this, and the change does not do it.",
  suggestion: undefined,
}

async function openOverview() {
  const review = {
    ...detail,
    result: {
      ...detail.result!,
      findings: [...detail.result!.findings, gap],
      walkthrough: {
        ...detail.result!.walkthrough!,
        linkedIssues: [
          {
            ref: "#10",
            title: "Original request",
            state: "open" as const,
            assessment: "partial" as const,
            note: "Half done.",
            requirements: [
              { text: "Export as CSV", status: "met" as const, file: "src/app.ts", line: 11 },
              { text: "Log each export", status: "missing" as const, fix: "Add a log line after the export." },
            ],
          },
        ],
      },
    },
  }
  mockApi({ [`GET /api/reviews/${detail.id}`]: { review } })
  renderWithProviders(<App />, { route: `/reviews/${detail.id}?view=overview` })
  await screen.findByText("Adds b and c.")
}

describe("Linked issue requirements", () => {
  it("lists each requirement with its status, location and fix", async () => {
    await openOverview()
    const section = screen.getByRole("region", { name: "Linked issues" })
    await userEvent.click(within(section).getByRole("button", { name: /^Linked issues/ }))

    expect(within(section).getByText("1 of 2 requirements met")).toBeInTheDocument()
    const list = within(section).getByRole("list", { name: "Requirements" })
    const [met, missing] = within(list).getAllByRole("listitem")
    expect(within(met).getByRole("img", { name: "Met" })).toBeInTheDocument()
    expect(met).toHaveTextContent("Export as CSV src/app.ts:11")
    expect(within(missing).getByRole("img", { name: "Missing" })).toBeInTheDocument()
    expect(missing).toHaveTextContent("Add a log line after the export.")
  })

  it("shows a gap without a file under the linked issue, not an empty path", async () => {
    await openOverview()
    expect(screen.getByText("Linked issue")).toBeInTheDocument()
    expect(screen.queryByText(/^:1$/)).not.toBeInTheDocument()
    expect(findingPrompt(gap).split("\n")[0]).toBe("In this change: #10: Log each export")
  })
})
