import { describe, expect, it } from "vitest"
import type { ApiKey } from "./api"
import { connectionState, isCheckable, needsAttention } from "./health"

const key: ApiKey = {
  provider: "anthropic",
  stored: true,
  last4: "1234",
  undecryptable: false,
  baseUrl: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  serverDefault: false,
  blocked: false,
}

describe("connectionState", () => {
  it("ignores a lingering check result once the key is gone", () => {
    expect(connectionState({ ...key, stored: false }, "blocked")).toBe("none")
    expect(connectionState({ ...key, stored: false, serverDefault: true }, "revoked")).toBe("server")
  })

  it("blocks by the policy flag whether or not a key is stored", () => {
    expect(connectionState({ ...key, stored: false, blocked: true }, undefined)).toBe("blocked")
    expect(connectionState({ ...key, blocked: true }, "active")).toBe("blocked")
  })

  it("reads a stored key's check", () => {
    expect(connectionState(key, "blocked")).toBe("blocked")
    expect(connectionState(key, "revoked")).toBe("rejected")
    expect(connectionState(key, "unreachable")).toBe("unverified")
    expect(connectionState(key, "active")).toBe("active")
    expect(connectionState(key, undefined)).toBe("checking")
  })
})

describe("isCheckable", () => {
  it("checks only stored keys the server would call", () => {
    expect(isCheckable(key)).toBe(true)
    expect(isCheckable({ ...key, stored: false })).toBe(false)
    expect(isCheckable({ ...key, undecryptable: true })).toBe(false)
    expect(isCheckable({ ...key, blocked: true })).toBe(false)
  })
})

describe("needsAttention", () => {
  it("never counts a key that is not stored", () => {
    expect(needsAttention({ ...key, stored: false, blocked: true }, "blocked")).toBe(false)
  })
})
