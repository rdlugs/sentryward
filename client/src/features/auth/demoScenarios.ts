import type { Severity, Verdict } from "@/features/reviews/types"

export interface DemoLine {
  kind: "context" | "add" | "del"
  text: string
}

export interface DemoScenario {
  file: string
  lines: DemoLine[]
  /** Index in `lines` the finding is posted under. */
  commentLine: number
  severity: Severity
  title: string
  body: string
  suggestion: string
  verdict: Verdict
}

// Made-up changes for the auth panel's example review. Keep them short (the
// card has to fit a 768px-tall screen) and clear of the strings the auth page
// tests look for (field labels, button names).
export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    file: "src/api/users.ts",
    lines: [
      { kind: "context", text: "export async function findUser(name: string) {" },
      { kind: "add", text: "  const sql = \"SELECT * FROM users WHERE name = '\" + name + \"'\"" },
      { kind: "add", text: "  return db.query(sql)" },
      { kind: "context", text: "}" },
    ],
    commentLine: 1,
    severity: "critical",
    title: "SQL built from user input",
    body: "The name goes straight into the query, so a crafted value can read or drop any table.",
    suggestion: "return db.query(\"SELECT * FROM users WHERE name = $1\", [name])",
    verdict: "blocked",
  },
  {
    file: "src/jobs/sync.ts",
    lines: [
      { kind: "context", text: "const items = await fetchPending()" },
      { kind: "del", text: "if (!items.length) return" },
      { kind: "add", text: "const first = items[0].id" },
      { kind: "add", text: "await markSynced(first)" },
    ],
    commentLine: 2,
    severity: "major",
    title: "Crash on an empty batch",
    body: "The empty check is gone, so items[0] is undefined whenever nothing is pending.",
    suggestion: "const first = items[0]?.id; if (!first) return",
    verdict: "blocked",
  },
  {
    file: "src/ui/Table.tsx",
    lines: [
      { kind: "context", text: "<tbody>" },
      { kind: "add", text: "  {rows.map((row) => (" },
      { kind: "add", text: "    <Row data={row} />" },
      { kind: "add", text: "  ))}" },
      { kind: "context", text: "</tbody>" },
    ],
    commentLine: 2,
    severity: "minor",
    title: "Rows are missing a key",
    body: "Without a key React can't follow rows between renders, so sorting can leave state on the wrong row.",
    suggestion: "<Row key={row.id} data={row} />",
    verdict: "pass",
  },
]
