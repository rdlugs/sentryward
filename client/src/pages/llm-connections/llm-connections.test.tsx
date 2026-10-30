import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"

const noKeys = {
  keys: [
    { provider: "anthropic", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
    { provider: "openai", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: true },
    { provider: "google", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
    { provider: "ollama", stored: false, last4: null, undecryptable: false, baseUrl: null, updatedAt: null, serverDefault: false },
  ],
}

const storedAnthropic = {
  provider: "anthropic",
  stored: true,
  last4: "1234",
  undecryptable: false,
  baseUrl: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  serverDefault: false,
}

function bodyOf(init?: RequestInit) {
  return JSON.parse(String(init?.body))
}

function calls(fetchSpy: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchSpy.mock.calls.filter(([url, init]) => String(url) === path && (init?.method ?? "GET") === method)
}

function card(name: string) {
  return screen.getByRole("listitem", { name })
}

async function openFromMenu(provider: string, item: string) {
  await userEvent.click(await screen.findByRole("button", { name: `Actions for ${provider}` }))
  await userEvent.click(await screen.findByRole("menuitem", { name: item }))
}

describe("LLM Connections page", () => {
  it("is reachable from the sidebar", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 }, "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("link", { name: "LLM Connections" }))

    expect(await screen.findByRole("heading", { name: "LLM Connections" })).toBeInTheDocument()
    expect(await screen.findByRole("list", { name: "LLM providers" })).toBeInTheDocument()
  })

  it("redirects the old settings tab", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/settings?tab=api-keys" })

    expect(await screen.findByRole("list", { name: "LLM providers" })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Profile" })).not.toBeInTheDocument()
  })

  it("keeps model prices on their own tab", async () => {
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "GET /api/settings/model-prices": {
        prices: [{ id: "p1", model: "openai/my-proxy", price: { input: 1.5, output: 6 }, updatedAt: "2026-10-20T00:00:00.000Z" }],
        models: [],
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(await screen.findByRole("list", { name: "LLM providers" })).toBeInTheDocument()
    expect(screen.queryByRole("table", { name: "Model prices" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("tab", { name: "Model prices" }))

    expect(await screen.findByRole("table", { name: "Model prices" })).toBeInTheDocument()
    expect(screen.queryByRole("list", { name: "LLM providers" })).not.toBeInTheDocument()
  })

  it("shows every provider, connected or not, and what its reviews use", async () => {
    const fetchSpy = mockApi({ "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/llm-connections" })

    const list = await screen.findByRole("list", { name: "LLM providers" })
    expect(within(list).getAllByRole("listitem").map((item) => item.getAttribute("aria-label"))).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
      "Ollama",
    ])
    expect(within(card("Anthropic")).getByText("Not connected")).toBeInTheDocument()
    expect(within(card("Anthropic")).getByRole("button", { name: "Connect" })).toBeEnabled()
    expect(within(card("OpenAI")).getByText("Server key")).toBeInTheDocument()
    expect(within(card("OpenAI")).getByText(/Reviews use the server's OpenAI key/)).toBeInTheDocument()
    expect(within(card("OpenAI")).getByRole("button", { name: "Use my own key" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument()
    expect(screen.getByText("0 of 4 providers connected")).toBeInTheDocument()
    // Nothing is stored, so there is nothing to check with a provider.
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/status"))).toHaveLength(0)
  })

  it("connects the provider of the card it was opened from", async () => {
    let keys: { keys: object[] } = noKeys
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": () => jsonResponse(200, keys),
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "PUT /api/settings/api-keys/anthropic": () => {
        keys = { keys: [storedAnthropic, ...noKeys.keys.slice(1)] }
        return jsonResponse(200, { key: storedAnthropic })
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    await userEvent.click(within(card("Anthropic")).getByRole("button", { name: "Connect" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByRole("heading", { name: "Connect Anthropic" })).toBeInTheDocument()
    expect(within(sheet).queryByRole("combobox", { name: "Provider" })).not.toBeInTheDocument()
    expect(within(sheet).getByRole("link", { name: "console.anthropic.com" })).toHaveAttribute(
      "href",
      "https://console.anthropic.com",
    )
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-secret-1234")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(await within(card("Anthropic")).findByText("••••1234")).toBeInTheDocument()
    expect(await within(card("Anthropic")).findByText("Active")).toBeInTheDocument()
    expect(screen.getByText("1 of 4 providers connected")).toBeInTheDocument()
    expect(bodyOf(calls(fetchSpy, "PUT", "/api/settings/api-keys/anthropic")[0]![1])).toEqual({
      apiKey: "sk-ant-secret-1234",
    })
  })

  it("adds a keyless Ollama connection with its default Docker host", async () => {
    const ollama = {
      provider: "ollama",
      stored: true,
      last4: null,
      undecryptable: false,
      baseUrl: "http://host.docker.internal:11434/v1",
      updatedAt: "2026-10-04T00:00:00.000Z",
      serverDefault: false,
    }
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": noKeys,
      "PUT /api/settings/api-keys/ollama": { key: ollama },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    await userEvent.click(within(card("Ollama")).getByRole("button", { name: "Connect" }))
    const sheet = await screen.findByRole("dialog")

    expect(within(sheet).getByLabelText("API base URL")).toHaveValue("http://host.docker.internal:11434/v1")
    expect(within(sheet).getByLabelText("Ollama API key (optional)")).toHaveValue("")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    await waitFor(() => expect(calls(fetchSpy, "PUT", "/api/settings/api-keys/ollama")).toHaveLength(1))
    expect(bodyOf(calls(fetchSpy, "PUT", "/api/settings/api-keys/ollama")[0]![1])).toEqual({
      baseUrl: "http://host.docker.internal:11434/v1",
    })
  })

  it("sends a custom host set under Advanced with a cloud provider key", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": noKeys,
      "PUT /api/settings/api-keys/anthropic": { key: storedAnthropic },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    await userEvent.click(within(card("Anthropic")).getByRole("button", { name: "Connect" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).queryByRole("switch", { name: "Use custom host" })).not.toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole("button", { name: "Advanced" }))
    await userEvent.click(within(sheet).getByRole("switch", { name: "Use custom host" }))
    await userEvent.type(within(sheet).getByLabelText("API base URL"), "https://anthropic.example/v1")
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-secret")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    await waitFor(() => expect(calls(fetchSpy, "PUT", "/api/settings/api-keys/anthropic")).toHaveLength(1))
    expect(bodyOf(calls(fetchSpy, "PUT", "/api/settings/api-keys/anthropic")[0]![1])).toEqual({
      apiKey: "sk-ant-secret",
      baseUrl: "https://anthropic.example/v1",
    })
  })

  it("keeps the sheet open and shows a failed connection on the field", async () => {
    mockApi({
      "GET /api/settings/api-keys": noKeys,
      "PUT /api/settings/api-keys/anthropic": () =>
        jsonResponse(400, { message: "Connection failed", errors: { apiKey: ["The API host rejected this key"] } }),
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    await userEvent.click(within(card("Anthropic")).getByRole("button", { name: "Connect" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-invalid")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    expect(await within(sheet).findByText("The API host rejected this key")).toBeInTheDocument()
    expect(sheet).toBeInTheDocument()
  })

  it("offers to replace a rejected key and rechecks its status after replacement", async () => {
    let status = "revoked"
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": () => jsonResponse(200, { status }),
      "PUT /api/settings/api-keys/anthropic": () => {
        status = "active"
        return jsonResponse(200, { key: storedAnthropic })
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(await screen.findByText("Key rejected")).toBeInTheDocument()
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(1)
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/openai/status")).toHaveLength(0)
    const anthropic = card("Anthropic")
    expect(within(anthropic).getByText("••••1234")).toBeInTheDocument()
    expect(within(anthropic).getByText("Official API")).toBeInTheDocument()
    expect(within(anthropic).getByText(/The provider rejected the stored key/)).toBeInTheDocument()
    expect(screen.getByText("1 of 4 providers connected · 1 needs attention")).toBeInTheDocument()
    await userEvent.click(within(anthropic).getByRole("button", { name: "Replace key" }))
    const sheet = await screen.findByRole("dialog")

    expect(within(sheet).getByRole("heading", { name: "Replace Anthropic key" })).toBeInTheDocument()
    expect(within(sheet).getByText(/A key ending in 1234 is stored/)).toBeInTheDocument()
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-replacement")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and replace" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() =>
      expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(2),
    )
    expect(await within(card("Anthropic")).findByText("Active")).toBeInTheDocument()
    expect(screen.getByText("1 of 4 providers connected")).toBeInTheDocument()
  })

  it("shows a key the server can no longer decrypt so it can be replaced or removed", async () => {
    const unreadable = { ...storedAnthropic, last4: null, undecryptable: true }
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [unreadable, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/capabilities": { capabilities: [] },
      "DELETE /api/settings/api-keys/anthropic": () => jsonResponse(204),
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    const anthropic = card("Anthropic")
    expect(within(anthropic).getByText("Unreadable")).toBeInTheDocument()
    expect(within(anthropic).getByText("Re-enter key")).toBeInTheDocument()
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(0)

    await userEvent.click(within(anthropic).getByRole("button", { name: "Replace key" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(/The stored key can't be decrypted/)).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    await userEvent.click(within(anthropic).getByRole("button", { name: "Details" }))
    const details = await screen.findByRole("dialog")
    expect(within(details).getByText(/Replace the key to test models/)).toBeInTheDocument()
    expect(within(details).queryByRole("button", { name: "Run test" })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    await openFromMenu("Anthropic", "Remove")
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove connection" }))

    await waitFor(() => expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(1))
  })

  it("points a provider the privacy policy blocks to the policy instead of connecting it", async () => {
    mockApi({
      "GET /api/settings/api-keys": {
        keys: noKeys.keys.map((key) => ({ ...key, blocked: key.provider === "google" })),
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await screen.findByRole("list", { name: "LLM providers" })
    const google = card("Google")
    expect(within(google).getByText("Blocked by policy")).toBeInTheDocument()
    expect(within(google).getByRole("button", { name: "Connect" })).toBeDisabled()
    expect(within(google).getByRole("link", { name: "Review policy" })).toHaveAttribute("href", "/privacy")
  })

  it("removes a stored key after confirming", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "DELETE /api/settings/api-keys/anthropic": () => jsonResponse(204),
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await openFromMenu("Anthropic", "Remove")
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove Anthropic connection?")).toBeInTheDocument()
    expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove connection" }))

    await waitFor(() => expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(1))
  })

  it("checks a connection again on request and says when it last did", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": { status: "unreachable" },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(await screen.findByText("Couldn't verify")).toBeInTheDocument()
    expect(within(card("Anthropic")).getByText("checked just now")).toBeInTheDocument()
    await userEvent.click(within(card("Anthropic")).getByRole("button", { name: "Check again" }))
    await waitFor(() =>
      expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(2),
    )

    await openFromMenu("Anthropic", "Check again")
    await waitFor(() =>
      expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(3),
    )
  })

  describe("testing a model", () => {
    const routes = (result: unknown) => ({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "GET /api/settings/api-keys/anthropic/models": { models: ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"] },
      "GET /api/settings/api-keys/anthropic/capabilities": { capabilities: [] },
      "POST /api/settings/api-keys/anthropic/test": result,
    })

    async function openTest() {
      await screen.findByRole("list", { name: "LLM providers" })
      await userEvent.click(within(card("Anthropic")).getByRole("button", { name: "Details" }))
      return screen.findByRole("dialog")
    }

    it("runs a model picked from the connection and reports success", async () => {
      const fetchSpy = mockApi(
        routes({ result: { ok: true, latencyMs: 812, inputTokens: 54, outputTokens: 6 } }),
      )
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openTest()
      expect(within(dialog).getByRole("button", { name: "Run test" })).toBeDisabled()
      await userEvent.click(within(dialog).getByRole("button", { name: "Choose Model from the connection" }))
      await userEvent.click(await screen.findByRole("option", { name: "anthropic/claude-sonnet-5-5" }))
      await userEvent.click(within(dialog).getByRole("button", { name: "Run test" }))

      expect(await within(dialog).findByRole("status")).toHaveTextContent(
        "Responded in 812 ms, 54 input / 6 output tokens",
      )
      const [post] = calls(fetchSpy, "POST", "/api/settings/api-keys/anthropic/test")
      expect(bodyOf(post![1])).toEqual({ model: "anthropic/claude-sonnet-5-5" })
    })

    it("shows what the probe after a passing test found", async () => {
      mockApi(
        routes({
          result: {
            ok: true,
            latencyMs: 400,
            inputTokens: 10,
            outputTokens: 2,
            capabilities: { thinking: "options", tools: false, detail: "thinking options work; tools are refused" },
          },
        }),
      )
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openTest()
      await userEvent.type(within(dialog).getByRole("textbox", { name: "Model" }), "anthropic/claude-sonnet-5-5")
      await userEvent.click(within(dialog).getByRole("button", { name: "Run test" }))

      const status = await within(dialog).findByRole("status")
      expect(within(status).getByText("Thinking")).toBeInTheDocument()
      expect(within(status).getByText("No tools")).toBeInTheDocument()
      expect(status).toHaveTextContent("tools are refused")
    })

    it("shows the provider's error and clears it when the model changes", async () => {
      mockApi(
        routes({
          result: { ok: false, reason: "model", message: "The API host does not serve this model: not_found_error" },
        }),
      )
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openTest()
      const input = within(dialog).getByRole("textbox", { name: "Model" })
      await userEvent.type(input, "anthropic/claude-nope")
      await userEvent.click(within(dialog).getByRole("button", { name: "Run test" }))

      expect(await within(dialog).findByRole("alert")).toHaveTextContent("does not serve this model")
      await userEvent.type(input, "2")
      expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    })

    it("shows a validation error under the model field", async () => {
      mockApi({
        ...routes({}),
        "POST /api/settings/api-keys/anthropic/test": () =>
          jsonResponse(400, {
            message: "Validation failed",
            errors: { model: ["This connection can only run anthropic/... models"] },
          }),
      })
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openTest()
      await userEvent.type(within(dialog).getByRole("textbox", { name: "Model" }), "openai/gpt-5")
      await userEvent.click(within(dialog).getByRole("button", { name: "Run test" }))

      expect(await within(dialog).findByText("This connection can only run anthropic/... models")).toBeInTheDocument()
    })
  })

  describe("capabilities", () => {
    const routes = (capabilities: unknown[]) => ({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "GET /api/settings/api-keys/anthropic/capabilities": { capabilities },
      "GET /api/settings/api-keys/anthropic/models": { models: [] },
    })

    async function openCapabilities() {
      await openFromMenu("Anthropic", "Details")
      return screen.findByRole("dialog")
    }

    it("lists what each model was found to support", async () => {
      mockApi(
        routes([
          {
            model: "anthropic/claude-sonnet-5-5",
            endpoint: null,
            thinking: "options",
            tools: true,
            source: "probe",
            detail: "thinking options work; tool calls work",
            checkedAt: "2026-10-20T00:00:00.000Z",
          },
          {
            model: "anthropic/claude-3-5-haiku-latest",
            endpoint: null,
            thinking: "none",
            tools: null,
            source: "runtime",
            detail: "Rejected thinking options",
            checkedAt: "2026-10-21T00:00:00.000Z",
          },
        ]),
      )
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openCapabilities()
      const sonnet = (await within(dialog).findByText("anthropic/claude-sonnet-5-5")).closest("tr")!
      expect(within(sonnet).getByText("Thinking")).toBeInTheDocument()
      expect(within(sonnet).getByText("Tools")).toBeInTheDocument()
      const haiku = within(dialog).getByText("anthropic/claude-3-5-haiku-latest").closest("tr")!
      expect(within(haiku).getByText("No thinking")).toBeInTheDocument()
      expect(within(haiku).getByText("Tools unknown")).toBeInTheDocument()
      expect(haiku).toHaveTextContent("(review)")
    })

    it("says how to detect capabilities when none are recorded", async () => {
      mockApi(routes([]))
      renderWithProviders(<App />, { route: "/llm-connections" })

      const dialog = await openCapabilities()
      expect(await within(dialog).findByText(/Nothing recorded yet/)).toBeInTheDocument()
    })
  })
})
