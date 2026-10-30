import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { ApiKeyStatusBadge, ConnectionStateBadge } from "./ApiKeyStatusBadge"

describe("ApiKeyStatusBadge", () => {
  it("shows progress while the connection is being checked", () => {
    render(<ApiKeyStatusBadge status={undefined} />)

    expect(screen.getByText("Checking...")).toBeInTheDocument()
  })

  it.each([
    ["active", "Active", "text-emerald-700"],
    ["revoked", "Key rejected", "text-destructive"],
    ["unreachable", "Couldn't verify", "text-amber-700"],
    ["blocked", "Blocked by policy", "text-destructive"],
  ] as const)("renders the %s state with its color", (status, label, colorClass) => {
    render(<ApiKeyStatusBadge status={status} />)

    expect(screen.getByText(label)).toHaveClass(colorClass)
  })

  it.each([
    ["unreadable", "Re-enter key"],
    ["server", "Server key"],
    ["none", "Not connected"],
  ] as const)("labels the %s state of a provider without a checked key", (state, label) => {
    render(<ConnectionStateBadge state={state} />)

    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
