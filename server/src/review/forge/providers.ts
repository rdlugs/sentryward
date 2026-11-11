import { MAX_CHANGE_NUMBER, type ForgeProvider } from "../core/models.ts";

// What the review pipeline needs to know about each forge, with no I/O. The
// application side (adapters, connecting, webhooks) lives in
// services/providers. Adding a forge:
//   1. Add it to ForgeProvider in prisma/schema.prisma (with a migration) and
//      to forgeProviderSchema in review/core/models.ts.
//   2. Write review/forge/<name>.ts implementing ForgeAdapter, ForgePublisher,
//      ForgeHooks and ForgeThreads.
//   3. Add an entry here and in services/providers/index.ts; both are keyed by
//      ForgeProvider, so the compiler points at whatever is missing.
//   4. Add the client entry in client/src/features/forge/providers.tsx.
export interface ForgeInfo {
  name: string;
  // What the forge calls a change, in full and short ("Open PR").
  changeNoun: string;
  changeAbbrev: string;
  // Recognises a change URL's path by its shape rather than its domain, so
  // self-hosted instances work without configuration.
  parseChangePath(path: string): { project: string; number: number } | null;
  // The info string of a suggestion block covering startLine..endLine.
  suggestionInfo(startLine: number, endLine: number): string;
  // A commit viewed inside its change, so the link keeps the PR/MR context.
  commitUrl(changeUrl: string, sha: string): string;
}

function pathMatcher(pattern: RegExp) {
  return (path: string) => {
    const match = pattern.exec(path);
    if (!match) return null;
    // A number no change can have is not a change URL; rejecting it here keeps
    // it away from the forge API and the integer column it would overflow.
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number) || number < 1 || number > MAX_CHANGE_NUMBER) return null;
    return { project: match[1]!, number };
  };
}

// Change URLs are matched in this order; GitLab's explicit /-/ goes first.
export const FORGE_INFO: Record<ForgeProvider, ForgeInfo> = {
  gitlab: {
    name: "GitLab",
    changeNoun: "merge request",
    changeAbbrev: "MR",
    parseChangePath: pathMatcher(/^\/(.+?)\/-\/merge_requests\/(\d+)(?:\/.*)?$/),
    // GitLab anchors on the first line, so the block says how many lines below
    // it to replace.
    suggestionInfo: (startLine, endLine) => `suggestion:-0+${endLine - startLine}`,
    commitUrl: (changeUrl, sha) => `${changeUrl}/diffs?commit_id=${sha}`,
  },
  github: {
    name: "GitHub",
    changeNoun: "pull request",
    changeAbbrev: "PR",
    parseChangePath: pathMatcher(/^\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/),
    // GitHub's suggestion replaces exactly the commented range.
    suggestionInfo: () => "suggestion",
    commitUrl: (changeUrl, sha) => `${changeUrl}/commits/${sha}`,
  },
};

export const FORGE_PROVIDERS = Object.keys(FORGE_INFO) as ForgeProvider[];

export function forgeName(provider: string): string {
  return Object.hasOwn(FORGE_INFO, provider) ? FORGE_INFO[provider as ForgeProvider].name : provider;
}
