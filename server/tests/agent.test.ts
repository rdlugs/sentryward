import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BUDGET_SPENT, MAX_DIR_ENTRIES, MAX_READ_LINES, agentTools, readsContext, safePath, searchBudget } from "../src/review/agent/tools.ts";
import { resolveConfig } from "../src/review/config/resolve.ts";
import type { Config, ConfigOverride } from "../src/review/config/schema.ts";
import type { ContextSource } from "../src/review/context/gather.ts";
import {
  abortableGenerateAgentic,
  createGenerateAgentic,
  ToolsUnsupportedError,
  toolsUnsupportedWarning,
  type AgenticRequest,
  type AgenticResponse,
  type GenerateAgentic,
} from "../src/review/llm/agentic.ts";
import { memoryLedger } from "../src/review/llm/capabilities.ts";
import { ModelCallError } from "../src/review/llm/providers.ts";
import { runReview } from "../src/review/pipeline.ts";
import { makeChangeSet } from "./helpers/changeSet.ts";
import { fetchStub, type StubRoute } from "./helpers/fetchStub.ts";
import { fakeModel, modelFinding } from "./helpers/model.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const config = (override: ConfigOverride = {}): Config =>
  resolveConfig({
    trigger: { output: { walkthrough: false }, ...override, review: { context: "agentic", ...override.review } },
  }).config;

const HELPER = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");

function source(files: Record<string, string> = { "src/helper.ts": HELPER }) {
  const searched: string[] = [];
  const context: ContextSource = {
    readFile: async (path) => files[path] ?? null,
    searchCode: async (term) => {
      searched.push(term);
      return Object.keys(files);
    },
  };
  return { context, searched };
}

// Calls a tool the way the SDK would, without a model.
const run = (tool: unknown, input: unknown) =>
  (tool as { execute: (input: unknown, options: unknown) => Promise<string> }).execute(input, {
    toolCallId: "t",
    messages: [],
    context: {},
  });

describe("agent tools", () => {
  it("refuses paths outside the repository", () => {
    for (const path of ["/etc/passwd", "../secrets", "src/../../x", "~/.ssh/id", "C:/x", "a\\b", "a//b", ""]) {
      expect(safePath(path)).toBeUndefined();
    }
    expect(safePath("./src/helper.ts")).toBe("src/helper.ts");
  });

  it("reads numbered lines, at most a page, wrapped as untrusted, and records them", async () => {
    const { tools, reads } = agentTools({ source: source().context, searches: searchBudget(5), maxToolTokens: 30_000 });

    const page = await run(tools.read_file, { path: "src/helper.ts" });
    expect(page).toMatch(/^<untrusted>\n=== CONTEXT: src\/helper.ts \(lines 1-400\) ===/);
    expect(page).toContain(`   400 : line 400`);
    expect(page).not.toContain("line 401\n");
    expect(page).toContain("read on with startLine 401");
    expect(page).toMatch(/<\/untrusted>$/);
    expect(reads).toEqual([expect.objectContaining({ path: "src/helper.ts", range: { start: 1, end: MAX_READ_LINES } })]);

    expect(await run(tools.read_file, { path: "../x" })).toMatch(/^Refused/);
    expect(await run(tools.read_file, { path: "missing.ts" })).toMatch(/does not exist/);
  });

  it("lists directories at the head revision, capped, wrapped as untrusted", async () => {
    const dirs: Record<string, string[]> = {
      "": ["README.md", "src/"],
      src: ["helper.ts", "users/", "helper.test.ts"],
      big: Array.from({ length: MAX_DIR_ENTRIES + 5 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`),
    };
    const listed: string[] = [];
    const context: ContextSource = {
      ...source().context,
      listDir: async (path) => {
        listed.push(path);
        return dirs[path] ? { entries: dirs[path], truncated: false } : null;
      },
    };
    const { tools } = agentTools({ source: context, searches: searchBudget(5), maxToolTokens: 30_000 });

    // Directories first, then files.
    expect(await run(tools.list_dir, { path: "./src/" })).toBe(
      "<untrusted>\nEntries of src/:\nusers/\nhelper.test.ts\nhelper.ts\n</untrusted>",
    );
    expect(await run(tools.list_dir, { path: "" })).toContain("Entries of the repository root:\nsrc/\nREADME.md");
    expect(await run(tools.list_dir, { path: "src/ " })).toContain("Entries of src/:");
    const big = await run(tools.list_dir, { path: "big" });
    expect(big).toContain(`f${MAX_DIR_ENTRIES - 1}.ts`);
    expect(big).not.toContain(`f${MAX_DIR_ENTRIES}.ts`);
    expect(big).toContain("(5 more not shown)");

    for (const path of ["../x", "/etc", "/", "src/../../x", "~"]) {
      expect(await run(tools.list_dir, { path })).toMatch(/^Refused/);
    }
    expect(await run(tools.list_dir, { path: "missing" })).toBe("missing is not a directory at the head revision.");
    expect(listed).toEqual(["src", "", "src", "big", "missing"]);
  });

  it("says a truncated listing is incomplete instead of counting what is missing", async () => {
    const entries = Array.from({ length: 100 }, (_, i) => `f${String(i).padStart(3, "0")}.ts`);
    const context: ContextSource = { ...source().context, listDir: async () => ({ entries, truncated: true }) };
    const { tools } = agentTools({ source: context, searches: searchBudget(5), maxToolTokens: 30_000 });

    const text = await run(tools.list_dir, { path: "tests" });
    expect(text).toContain(`(more than ${100 - MAX_DIR_ENTRIES} not shown; this listing is incomplete`);
    expect(text).not.toMatch(/\(\d+ more not shown\)/);
  });

  it("counts listings against the pass's budget", async () => {
    const context: ContextSource = {
      ...source().context,
      listDir: async () => ({
        entries: Array.from({ length: MAX_DIR_ENTRIES }, (_, i) => `a-rather-long-file-name-${i}.ts`),
        truncated: false,
      }),
    };
    const { tools } = agentTools({ source: context, searches: searchBudget(5), maxToolTokens: 600 });

    expect(await run(tools.list_dir, { path: "src" })).toMatch(/^<untrusted>/);
    expect(await run(tools.list_dir, { path: "src" })).toBe(BUDGET_SPENT);
  });

  it("offers list_dir only when the source can list directories", () => {
    expect(agentTools({ source: source().context, searches: searchBudget(5), maxToolTokens: 30_000 }).tools).not.toHaveProperty("list_dir");
  });

  it("stops returning code once the pass's budget is spent", async () => {
    const { tools, reads } = agentTools({ source: source().context, searches: searchBudget(5), maxToolTokens: 1_500 });

    expect(await run(tools.read_file, { path: "src/helper.ts", startLine: 1, endLine: 50 })).toContain("line 50");
    expect(await run(tools.read_file, { path: "src/helper.ts" })).toBe(BUDGET_SPENT);
    expect(reads).toHaveLength(1);
  });

  it("shares the search budget across passes", async () => {
    const searches = searchBudget(2);
    const { context, searched } = source();
    const first = agentTools({ source: context, searches, maxToolTokens: 30_000 });
    const second = agentTools({ source: context, searches, maxToolTokens: 30_000 });

    expect(await run(first.tools.search_code, { term: "helper" })).toContain("src/helper.ts");
    await run(second.tools.search_code, { term: "main" });
    expect(await run(first.tools.search_code, { term: "other" })).toMatch(/No code searches are left/);
    expect(searched).toEqual(["helper", "main"]);
  });

  it("renders what was read as context blocks for the verifier", () => {
    const lines = HELPER.split("\n");
    const text = readsContext([
      { path: "src/helper.ts", lines, range: { start: 2, end: 3 } },
      { path: "src/helper.ts", lines, range: { start: 3, end: 4 } },
    ]);
    expect(text).toBe(
      ["=== CONTEXT: src/helper.ts (read by the review) ===", "     2 : line 2", "     3 : line 3", "     4 : line 4"].join("\n"),
    );
  });
});

// OpenAI chat-completions streams behind a router: text, or one tool call.
function chat(reply: { text?: string; tool?: { name: string; args: string } }, usage = { prompt: 100, completion: 10 }) {
  const chunk = (extra: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "m", ...extra })}`;
  const delta = reply.tool
    ? { tool_calls: [{ index: 0, id: `call_${reply.tool.name}`, type: "function", function: { name: reply.tool.name, arguments: reply.tool.args } }] }
    : { role: "assistant", content: reply.text ?? "" };
  return [
    chunk({ choices: [{ index: 0, delta, finish_reason: null }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }] }),
    chunk({ choices: [], usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion } }),
    "data: [DONE]",
    "",
  ].join("\n\n");
}

const ROUTER = /^http:\/\/router\.test\/v1\/chat\/completions$/;
const step = (body: string, times = 1): StubRoute => ({
  method: "POST",
  url: ROUTER,
  body,
  headers: { "content-type": "text/event-stream" },
  times,
});
const router = { baseUrl: "http://router.test/v1", apiKey: "k" };
const REPORT = JSON.stringify({ findings: [modelFinding()] });
const READ = JSON.stringify({ path: "src/helper.ts", startLine: 1, endLine: 3 });

function agenticRequest(overrides: Partial<AgenticRequest<{ findings: unknown[] }>> = {}) {
  const { tools } = agentTools({ source: source().context, searches: searchBudget(5), maxToolTokens: 30_000 });
  return {
    model: "openai/gpt-x",
    system: "review",
    prompt: "diff",
    schema: z.object({ findings: z.array(z.unknown()) }),
    schemaName: "code_review",
    temperature: 0.2,
    maxOutputTokens: 1000,
    tools,
    maxSteps: 3,
    ...overrides,
  };
}

describe("createGenerateAgentic", () => {
  it("runs the tools, ends with the report, and sums usage across steps", async () => {
    const { fetch, calls } = fetchStub([
      step(chat({ tool: { name: "read_file", args: READ } }, { prompt: 100, completion: 10 })),
      step(chat({ tool: { name: "report_findings", args: REPORT } }, { prompt: 300, completion: 40 })),
    ]);
    vi.stubGlobal("fetch", fetch);
    const { ledger } = memoryLedger();

    const response = await createGenerateAgentic({}, router, {}, { ledger })(agenticRequest());

    expect(response.object.findings).toHaveLength(1);
    expect(response).toMatchObject({ steps: 2, toolCalls: { read_file: 1, report_findings: 1 }, inputTokens: 400, outputTokens: 50 });
    // The tool result went back to the model, wrapped.
    const second = JSON.parse(calls[1]!.body!);
    const toolMessage = second.messages.find((m: { role: string }) => m.role === "tool");
    expect(toolMessage.content).toContain("<untrusted>");
    expect(ledger.get("openai/gpt-x")).toEqual({ tools: true });
  });

  it("forces the report on the last step", async () => {
    const { fetch, calls } = fetchStub([
      step(chat({ tool: { name: "read_file", args: READ } }), 2),
      step(chat({ tool: { name: "report_findings", args: REPORT } })),
    ]);
    vi.stubGlobal("fetch", fetch);

    const response = await createGenerateAgentic({}, router)(agenticRequest({ maxSteps: 3 }));

    expect(response.steps).toBe(3);
    expect(JSON.parse(calls[0]!.body!).tool_choice).toBe("auto");
    expect(JSON.parse(calls[2]!.body!).tool_choice).toEqual({ type: "function", function: { name: "report_findings" } });
  });

  it("fails a pass that never reports and leaves nothing to parse", async () => {
    vi.stubGlobal("fetch", fetchStub([step(chat({ tool: { name: "read_file", args: READ } }), 3)]).fetch);

    const error = await createGenerateAgentic({}, router)(agenticRequest({ maxSteps: 3 })).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as Error).message).toMatch(/ended after 3 steps without reporting/);
  });

  it("reads a text answer like a static pass, without taking it as missing tools", async () => {
    vi.stubGlobal("fetch", fetchStub([step(chat({ text: REPORT }))]).fetch);
    const { ledger } = memoryLedger();

    const response = await createGenerateAgentic({}, router, {}, { ledger })(agenticRequest());

    expect(response.object.findings).toHaveLength(1);
    expect(response.warnings ?? []).not.toContain(toolsUnsupportedWarning("openai/gpt-x"));
    expect(ledger.get("openai/gpt-x")).toEqual({});
  });

  it("turns a refusal of tools into ToolsUnsupportedError, and remembers", async () => {
    vi.stubGlobal(
      "fetch",
      fetchStub([{ method: "POST", url: ROUTER, status: 400, body: { error: { message: "tools are not supported" } } }]).fetch,
    );
    const { ledger } = memoryLedger();

    await expect(createGenerateAgentic({}, router, {}, { ledger })(agenticRequest())).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(ledger.get("openai/gpt-x")).toEqual({ tools: false });
  });

  it.each([
    "Invalid schema for function report_findings: 'findings' is not valid",
    "tool_use ids were found without tool_result blocks immediately after",
  ])("does not remember a 400 that names tools without refusing them: %s", async (text) => {
    vi.stubGlobal("fetch", fetchStub([{ method: "POST", url: ROUTER, status: 400, body: { error: { message: text } } }]).fetch);
    const { ledger } = memoryLedger();

    const error = await createGenerateAgentic({}, router, {}, { ledger })(agenticRequest()).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).not.toBeInstanceOf(ToolsUnsupportedError);
    expect(ledger.get("openai/gpt-x")).toEqual({});
  });

  it("drops thinking, not tools, when thinking is refused beside a forced tool", async () => {
    const { fetch, calls } = fetchStub([
      {
        method: "POST",
        url: ROUTER,
        status: 400,
        body: { error: { message: "Thinking may not be enabled when tool_choice forces tool use." } },
        times: 1,
      },
      step(chat({ tool: { name: "report_findings", args: REPORT } })),
    ]);
    vi.stubGlobal("fetch", fetch);
    const { ledger } = memoryLedger();

    const response = await createGenerateAgentic({}, router, {}, { ledger })(agenticRequest({ thinking: "high" }));

    expect(response.object.findings).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(ledger.get("openai/gpt-x")).toEqual({ thinking: "none", tools: true });
  });

  it("does not offer tools to a model recorded without them", async () => {
    const { fetch, calls } = fetchStub([]);
    vi.stubGlobal("fetch", fetch);
    const { ledger } = memoryLedger({ "openai/gpt-x": { tools: false } });

    await expect(createGenerateAgentic({}, router, {}, { ledger })(agenticRequest())).rejects.toBeInstanceOf(ToolsUnsupportedError);
    expect(calls).toEqual([]);
  });

  it("stops mid-loop when the review is cancelled", async () => {
    const controller = new AbortController();
    const { context } = source();
    const tools = agentTools({
      source: {
        ...context,
        readFile: async (path) => {
          controller.abort();
          return context.readFile(path);
        },
      },
      searches: searchBudget(5),
      maxToolTokens: 30_000,
    }).tools;
    const { fetch, calls } = fetchStub([
      step(chat({ tool: { name: "read_file", args: READ } })),
      step(chat({ tool: { name: "report_findings", args: REPORT } })),
    ]);
    vi.stubGlobal("fetch", fetch);

    const generate = abortableGenerateAgentic(createGenerateAgentic({}, router), controller.signal);
    await expect(generate(agenticRequest({ tools }))).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("runReview with agentic context", () => {
  const now = () => new Date("2026-10-04T12:00:00Z");

  // Reads src/helper.ts through the pass's tool, then reports.
  function fakeAgentic(respond: (request: AgenticRequest<unknown>) => unknown) {
    const requests: AgenticRequest<unknown>[] = [];
    const generateAgentic: GenerateAgentic = async <T>(request: AgenticRequest<T>): Promise<AgenticResponse<T>> => {
      requests.push(request as AgenticRequest<unknown>);
      await run(request.tools.read_file, { path: "src/helper.ts", startLine: 5, endLine: 6 });
      const object = respond(request as AgenticRequest<unknown>);
      if (object instanceof Error) throw object;
      return {
        object: object as T,
        model: request.model,
        inputTokens: 900,
        outputTokens: 60,
        latencyMs: 9,
        steps: 2,
        toolCalls: { read_file: 1, report_findings: 1 },
      };
    };
    return { generateAgentic, requests };
  }

  it("records steps and tool calls, and shows the verifier what the pass read", async () => {
    const { generateAgentic, requests } = fakeAgentic(() => ({ findings: [modelFinding({ severity: "critical" })] }));
    const { generate, requests: calls } = fakeModel({ verification: { verdict: "confirmed", reason: "ok" } });

    const result = await runReview(
      { changeSet: makeChangeSet(), config: config({ review: { verify: "all" } }) },
      { generate, generateAgentic, context: source().context, now },
    );

    expect(requests[0]!.system).toContain("<untrusted>");
    expect(requests[0]!.maxSteps).toBe(8);
    expect(result.usage.find((u) => u.purpose === "review")).toMatchObject({ steps: 2, toolCalls: { read_file: 1, report_findings: 1 } });
    const verify = calls.find((call) => call.schemaName === "verification")!;
    expect(verify.prompt).toContain("=== CONTEXT: src/helper.ts (read by the review) ===\n     5 : line 5");
  });

  it("reviews a pass statically when the model cannot call tools", async () => {
    const { generateAgentic } = fakeAgentic(() => new ToolsUnsupportedError("anthropic/claude-sonnet-5-5"));
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });

    const result = await runReview(
      { changeSet: makeChangeSet(), config: config() },
      { generate, generateAgentic, context: source().context, now },
    );

    expect(result.status).toBe("completed");
    expect(requests.map((r) => r.schemaName)).toEqual(["code_review"]);
    expect(result.warnings).toContain(toolsUnsupportedWarning("anthropic/claude-sonnet-5-5"));
  });

  it("reviews a pass statically when one model lacks tools and another fails otherwise", async () => {
    const { generateAgentic } = fakeAgentic((request) =>
      request.model === "openai/gpt-x" ? new ToolsUnsupportedError("openai/gpt-x") : new ModelCallError("503 busy", []),
    );
    const { generate, requests } = fakeModel({ code_review: { findings: [] } });

    const result = await runReview(
      { changeSet: makeChangeSet(), config: config({ llm: { fallbackModels: ["openai/gpt-x"] } }) },
      { generate, generateAgentic, context: source().context, now },
    );

    expect(result.status).toBe("completed");
    expect(requests.map((r) => r.schemaName)).toEqual(["code_review"]);
    expect(result.warnings).toContain(toolsUnsupportedWarning("openai/gpt-x"));
  });

  it("does not try the fallbacks of a cancelled pass", async () => {
    const { generateAgentic, requests } = fakeAgentic(() => new DOMException("Review cancelled", "AbortError"));
    const { generate } = fakeModel({ code_review: { findings: [] } });

    const result = await runReview(
      { changeSet: makeChangeSet(), config: config({ llm: { fallbackModels: ["openai/gpt-x"] } }) },
      { generate, generateAgentic, context: source().context, now },
    );

    expect(requests).toHaveLength(1);
    expect(result.coverage.omissions).toEqual([expect.objectContaining({ reason: "chunk_failed" })]);
  });

  it("counts a pass that fails its loop as chunk_failed", async () => {
    const { generateAgentic } = fakeAgentic(() => new ModelCallError("The pass ended after 8 steps without reporting findings", []));
    const { generate } = fakeModel({});

    const result = await runReview(
      { changeSet: makeChangeSet(), config: config() },
      { generate, generateAgentic, context: source().context, now },
    );

    expect(result.status).toBe("failed");
    expect(result.coverage.omissions).toEqual([expect.objectContaining({ reason: "chunk_failed" })]);
  });

  it("falls back to static context with a warning when there is no code source", async () => {
    const { generateAgentic, requests: agentic } = fakeAgentic(() => ({ findings: [] }));
    const { generate } = fakeModel({ code_review: { findings: [] } });

    const result = await runReview({ changeSet: makeChangeSet(), config: config() }, { generate, generateAgentic, now });

    expect(agentic).toEqual([]);
    expect(result.warnings[0]).toMatch(/Agentic context needs a code source/);
  });
});
