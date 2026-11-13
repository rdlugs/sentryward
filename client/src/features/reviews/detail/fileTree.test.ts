import { describe, expect, it } from "vitest"
import { finding } from "@/test/fixtures"
import type { ChangedFile } from "../types"
import { buildFileTree, treeOrder, type TreeNode } from "./fileTree"

const file = (path: string): ChangedFile => ({ path, changeType: "modified", additions: 1, deletions: 0 })

// Names only, nested, so a whole tree reads in one assertion.
function shape(nodes: TreeNode[]): unknown[] {
  return nodes.map((node) => (node.kind === "file" ? node.name : { [node.name]: shape(node.children) }))
}

describe("buildFileTree", () => {
  it("folds single-child directories and lists directories before files", () => {
    const tree = buildFileTree(
      [file("README.md"), file("src/review/forge/gitlab.ts"), file("src/review/forge/github.ts"), file("src/app.ts"), file("a.ts")],
      [],
    )
    expect(shape(tree)).toEqual([{ src: [{ "review/forge": ["github.ts", "gitlab.ts"] }, "app.ts"] }, "a.ts", "README.md"])
  })

  it("folds a top-level chain of directories into one node", () => {
    const tree = buildFileTree([file("resources/js/views/A.vue"), file("resources/js/views/B.vue")], [])
    expect(shape(tree)).toEqual([{ "resources/js/views": ["A.vue", "B.vue"] }])
    expect(tree[0]).toMatchObject({ path: "resources/js/views" })
  })

  it("counts each file's findings and keeps the most severe", () => {
    const tree = buildFileTree(
      [file("a.ts"), file("b.ts")],
      [finding({ file: "a.ts", severity: "minor" }), finding({ file: "a.ts", severity: "critical" })],
    )
    expect(tree).toMatchObject([
      { name: "a.ts", findings: 2, worst: "critical" },
      { name: "b.ts", findings: 0 },
    ])
    expect(tree[1]).not.toHaveProperty("worst")
  })

  it("orders files as the tree shows them", () => {
    const tree = buildFileTree([file("z.ts"), file("lib/b.ts"), file("lib/a.ts")], [])
    expect(treeOrder(tree).map((f) => f.path)).toEqual(["lib/a.ts", "lib/b.ts", "z.ts"])
  })
})
