import { SEVERITIES, type ChangedFile, type Finding, type Severity } from "../types"

export interface TreeFile {
  kind: "file"
  name: string
  file: ChangedFile
  findings: number
  // The most severe finding on the file, for the tree's badge colour.
  worst?: Severity
}

export interface TreeDir {
  kind: "dir"
  // A chain of single-child directories is one node ("src/review/forge"), so
  // a deep path does not cost a level of indentation per segment.
  name: string
  path: string
  children: TreeNode[]
}

export type TreeNode = TreeDir | TreeFile

interface Building {
  dirs: Map<string, Building>
  files: TreeFile[]
}

function sortNodes(nodes: TreeNode[]) {
  return nodes.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1))
}

function finish(name: string, path: string, node: Building): TreeDir {
  let dir = { name, path, node }
  // Only a directory holding exactly one directory and no files folds into it.
  while (dir.node.files.length === 0 && dir.node.dirs.size === 1) {
    const [[childName, child]] = dir.node.dirs
    dir = { name: `${dir.name}/${childName}`, path: `${dir.path}/${childName}`, node: child }
  }
  const children: TreeNode[] = [
    ...[...dir.node.dirs].map(([childName, child]) => finish(childName, `${dir.path}/${childName}`, child)),
    ...dir.node.files,
  ]
  return { kind: "dir", name: dir.name, path: dir.path, children: sortNodes(children) }
}

// The change's files as a directory tree, directories first, each file with
// the findings reported on it.
export function buildFileTree(files: ChangedFile[], findings: Finding[]): TreeNode[] {
  const byFile = new Map<string, Finding[]>()
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding])

  const root: Building = { dirs: new Map(), files: [] }
  for (const file of files) {
    const segments = file.path.split("/")
    const name = segments.pop()!
    let node = root
    for (const segment of segments) {
      let next = node.dirs.get(segment)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        node.dirs.set(segment, next)
      }
      node = next
    }
    const on = byFile.get(file.path) ?? []
    const worst = SEVERITIES.find((severity) => on.some((finding) => finding.severity === severity))
    node.files.push({ kind: "file", name, file, findings: on.length, ...(worst ? { worst } : {}) })
  }

  // The root itself never folds: top-level files and directories stay visible.
  return sortNodes([...[...root.dirs].map(([name, child]) => finish(name, name, child)), ...root.files])
}

// Files in the order the tree shows them, for picking the first one.
export function treeOrder(nodes: TreeNode[]): ChangedFile[] {
  return nodes.flatMap((node) => (node.kind === "file" ? [node.file] : treeOrder(node.children)))
}
