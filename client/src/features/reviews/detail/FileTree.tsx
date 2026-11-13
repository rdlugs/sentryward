import { useMemo } from "react"
import { ChevronRight, FileMinus, FilePen, FilePlus, FileSymlink, Folder, LayoutList } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { SEVERITY_CLASS } from "../severity"
import type { ChangedFile, Finding } from "../types"
import { buildFileTree, type TreeNode } from "./fileTree"

const CHANGE_ICON = {
  added: { icon: FilePlus, className: "text-emerald-600 dark:text-emerald-400" },
  deleted: { icon: FileMinus, className: "text-destructive" },
  renamed: { icon: FileSymlink, className: "text-sky-600 dark:text-sky-400" },
  modified: { icon: FilePen, className: "text-muted-foreground" },
} as const

function changeIcon(changeType: string) {
  return CHANGE_ICON[changeType as keyof typeof CHANGE_ICON] ?? CHANGE_ICON.modified
}

const ROW = "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"

function Nodes({
  nodes,
  depth,
  selected,
  onSelect,
}: {
  nodes: TreeNode[]
  depth: number
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  // Indented by depth on the row itself, so the highlight spans the whole width.
  const indent = { paddingLeft: `calc(${depth} * 0.75rem + 0.5rem)` }
  return nodes.map((node) => {
    if (node.kind === "dir") {
      return (
        <Collapsible key={node.path} defaultOpen asChild>
          <li>
            <CollapsibleTrigger className={cn(ROW, "group text-muted-foreground")} style={indent}>
              <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
              <Folder aria-hidden className="size-4 shrink-0" />
              <span className="min-w-0 truncate" title={node.path}>
                {node.name}
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent asChild>
              <ul>
                <Nodes nodes={node.children} depth={depth + 1} selected={selected} onSelect={onSelect} />
              </ul>
            </CollapsibleContent>
          </li>
        </Collapsible>
      )
    }
    const { icon: Icon, className } = changeIcon(node.file.changeType)
    const current = selected === node.file.path
    return (
      <li key={node.file.path}>
        <button
          type="button"
          aria-current={current ? "page" : undefined}
          onClick={() => onSelect(node.file.path)}
          className={cn(ROW, current && "bg-accent font-medium text-accent-foreground")}
          // Lines up with a sibling directory's name rather than its chevron.
          style={{ paddingLeft: `calc(${depth} * 0.75rem + 1.875rem)` }}
          title={node.file.path}
        >
          <Icon aria-label={node.file.changeType} className={cn("size-4 shrink-0", className)} />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
          {node.worst && (
            <span
              aria-label={`${node.findings} ${node.findings === 1 ? "finding" : "findings"}`}
              className={cn("rounded-full px-1.5 text-xs tabular-nums", SEVERITY_CLASS[node.worst])}
            >
              {node.findings}
            </span>
          )}
          <span className="shrink-0 text-xs tabular-nums">
            <span className="text-emerald-700 dark:text-emerald-400">+{node.file.additions}</span>{" "}
            <span className="text-destructive">-{node.file.deletions}</span>
          </span>
        </button>
      </li>
    )
  })
}

// The change's files, with an Overview entry above them for the walkthrough
// and the full findings list. `selected` is a file path, or null for Overview.
export function FileTree({
  files,
  findings,
  selected,
  onSelect,
}: {
  files: ChangedFile[]
  findings: Finding[]
  selected: string | null
  onSelect: (path: string | null) => void
}) {
  const tree = useMemo(() => buildFileTree(files, findings), [files, findings])
  return (
    <nav aria-label="Changed files" className="flex flex-col gap-1">
      <button
        type="button"
        aria-current={selected === null ? "page" : undefined}
        onClick={() => onSelect(null)}
        className={cn(ROW, selected === null && "bg-accent font-medium text-accent-foreground")}
      >
        <LayoutList aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex-1">Overview</span>
        {findings.length > 0 && <span className="text-xs text-muted-foreground tabular-nums">{findings.length}</span>}
      </button>
      <h2 className="px-2 pt-2 text-xs font-medium text-muted-foreground">
        Files changed <span className="tabular-nums">({files.length})</span>
      </h2>
      <ul>
        <Nodes nodes={tree} depth={0} selected={selected} onSelect={onSelect} />
      </ul>
    </nav>
  )
}
