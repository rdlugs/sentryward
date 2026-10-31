import { describe, expect, it } from "vitest";
import { ForgeHttp, type FetchLike } from "../src/review/forge/http.ts";

// A fetch that accepts the connection and never answers, honoring the signal
// the way real fetch does: the returned promise rejects when it aborts.
function hangingFetch(calls: { signal: AbortSignal | null }[] = []) {
  return async (_url: string, init: RequestInit = {}) => {
    const signal = init.signal ?? null;
    calls.push({ signal });
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

const http = (fetch: FetchLike, timeoutMs?: number) =>
  new ForgeHttp({
    baseUrl: "https://forge.acme.com",
    headers: async () => ({ authorization: "token tok" }),
    fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });

describe("ForgeHttp timeouts", () => {
  it("aborts a request when the forge never answers", async () => {
    const calls: { signal: AbortSignal | null }[] = [];
    const pending = http(hangingFetch(calls), 30).request("/repos/acme/web");
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls[0]!.signal).not.toBeNull();
  });

  it("bounds the whole redirect chain with one signal", async () => {
    const calls: { signal: AbortSignal | null }[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      if (calls.length === 0) {
        calls.push({ signal: init.signal ?? null });
        return new Response(null, { status: 301, headers: { location: "https://forge.acme.com/moved" } });
      }
      return hangingFetch(calls)(url, init);
    };
    const pending = http(fetch, 30).request("/repos/acme/web");
    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls.length).toBe(2);
    expect(calls[1]!.signal).not.toBeNull();
    // Both hops share the deadline; a fresh signal per hop would double it.
    expect(calls[1]!.signal).toBe(calls[0]!.signal);
  });

  it("keeps a caller-provided signal instead of the timeout", async () => {
    const calls: { signal: AbortSignal | null }[] = [];
    const caller = new AbortController();
    const pending = http(hangingFetch(calls), 30_000).request("/repos/acme/web", { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]!.signal).toBe(caller.signal);
  });
});
