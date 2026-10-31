export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ForgeError extends Error {
  // GitHub answers an exhausted rate limit with 403, the same status as a
  // refused token, so callers deciding a connection is broken must check this.
  public rateLimited: boolean;

  constructor(
    public status: number,
    message: string,
    options: { rateLimited?: boolean } = {},
  ) {
    super(message);
    this.rateLimited = options.rateLimited ?? false;
  }
}

export interface ForgeHttpOptions {
  baseUrl: string;
  headers: () => Promise<Record<string, string>>;
  fetch?: FetchLike;
  // Test hook; production requests always use FORGE_TIMEOUT_MS.
  timeoutMs?: number;
}

// Thin JSON client shared by both adapters. Errors carry the forge's status so
// callers can tell "not found" from "not allowed" from "the forge is down".
export class ForgeHttp {
  constructor(private options: ForgeHttpOptions) {}

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    let url = this.sameOrigin(path.startsWith("http") ? path : `${this.options.baseUrl}${path}`);
    const doFetch = this.options.fetch ?? globalThis.fetch;
    const json: Record<string, string> = typeof init.body === "string" ? { "Content-Type": "application/json" } : {};
    const headers = { ...json, ...(await this.options.headers()), ...(init.headers as Record<string, string> | undefined) };
    // A forge that accepts the connection but never answers would hang the
    // worker's runJob promise (whose memory is only freed when it settles) and
    // the webhook handlers that call the forge inline. One signal bounds every
    // hop; a caller bringing its own signal keeps control.
    const signal = init.signal ?? AbortSignal.timeout(this.options.timeoutMs ?? FORGE_TIMEOUT_MS);
    let res = await doFetch(url, { ...init, headers, redirect: "manual", signal });
    // Redirects are followed by hand so each hop gets the same origin check;
    // GitHub answers renamed repositories with a 301 on its own API host.
    for (let hop = 0; isRedirect(res.status) && hop < MAX_REDIRECTS; hop++) {
      const location = res.headers.get("location");
      if (!location) {
        break;
      }
      url = this.sameOrigin(new URL(location, url).toString());
      res = await doFetch(url, { ...init, headers, redirect: "manual", signal });
    }
    if (isRedirect(res.status)) {
      throw new ForgeError(res.status, `${init.method ?? "GET"} ${url} redirected too many times`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let message = body.slice(0, 300);
      try {
        const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
        message = String(parsed.message ?? parsed.error ?? message);
      } catch {
        // Not JSON; keep the raw excerpt.
      }
      throw new ForgeError(res.status, `${init.method ?? "GET"} ${url} failed (${res.status}): ${message}`, {
        rateLimited: isRateLimited(res, message),
      });
    }
    return res;
  }

  // Every request carries the connection's token, and the forge host is only
  // vetted when the connection is made. Absolute URLs (pagination links,
  // redirects) come from the forge's responses, so a forge must not be able to
  // point the server, token included, at any other host.
  private sameOrigin(url: string): string {
    const { origin } = new URL(url);
    if (origin !== new URL(this.options.baseUrl).origin) {
      throw new ForgeError(502, `Forge pointed to another host (${origin}); refusing to follow`);
    }
    return url;
  }

  async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  // Follows pagination until exhausted or `maxPages` is reached. `nextUrl` reads
  // the forge's own pagination signal from the response.
  async paginate<T>(
    path: string,
    nextUrl: (res: Response, current: string) => string | null,
    maxPages = 30,
    pick: (body: unknown) => T[] = (body) => body as T[],
  ): Promise<T[]> {
    const items: T[] = [];
    let url: string | null = path;
    for (let page = 0; url && page < maxPages; page++) {
      const res = await this.request(url);
      items.push(...pick(await res.json()));
      url = nextUrl(res, url);
    }
    return items;
  }
}

const MAX_REDIRECTS = 3;

// Generous enough for a slow self-hosted forge, tight enough that a hung run
// is failed and collected well before the worker's own 30-minute ceiling.
const FORGE_TIMEOUT_MS = 30_000;

// The primary limit shows in x-ratelimit-remaining; GitHub's secondary limits
// send retry-after, or sometimes only say so in the message.
function isRateLimited(res: Response, message: string): boolean {
  if (res.status !== 403 && res.status !== 429) {
    return false;
  }
  return (
    res.headers.get("x-ratelimit-remaining") === "0" ||
    res.headers.has("retry-after") ||
    /rate limit/i.test(message)
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

export function linkHeaderNext(res: Response): string | null {
  const link = res.headers.get("link");
  const match = link?.split(",").find((part) => /rel="next"/.test(part));
  return match ? (/<([^>]+)>/.exec(match)?.[1] ?? null) : null;
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ForgeError && err.status === 404;
}
