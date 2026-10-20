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

async function chooseFilter(label: string, option: string) {
  await userEvent.click(screen.getByRole("button", { name: "Filters" }))
  await userEvent.click(await screen.findByRole("combobox", { name: label }))
  await userEvent.click(screen.getByRole("option", { name: option }))
}

describe("LLM Connections page", () => {
  it("is reachable from the sidebar", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 }, "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/repositories" })

    await userEvent.click(await screen.findByRole("link", { name: "LLM Connections" }))

    expect(await screen.findByRole("heading", { name: "LLM Connections" })).toBeInTheDocument()
    expect(await screen.findByText("No API keys yet")).toBeInTheDocument()
  })

  it("redirects the old settings tab", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/settings?tab=api-keys" })

    expect(await screen.findByText("No API keys yet")).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Profile" })).not.toBeInTheDocument()
  })

  it("shows one add button and an empty state when no key is stored", async () => {
    mockApi({ "GET /api/settings/api-keys": noKeys })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(await screen.findByText("No API keys yet")).toBeInTheDocument()
    expect(screen.getByText(/reviews use the server's key for OpenAI/)).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Add Connection" })).toHaveLength(1)
  })

  it("adds a key for the provider picked in the sheet", async () => {
    let keys: { keys: object[] } = noKeys
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": () => jsonResponse(200, keys),
      "PUT /api/settings/api-keys/anthropic": () => {
        keys = { keys: [storedAnthropic, ...noKeys.keys.slice(1)] }
        return jsonResponse(200, { key: storedAnthropic })
      },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Add Connection" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Provider" }))
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Anthropic",
      "OpenAI",
      "Google",
      "Ollama",
    ])
    await userEvent.click(screen.getByRole("option", { name: "Anthropic" }))
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-secret-1234")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(await screen.findByText("••••1234")).toBeInTheDocument()
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

    await userEvent.click(await screen.findByRole("button", { name: "Add Connection" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.click(within(sheet).getByRole("combobox", { name: "Provider" }))
    await userEvent.click(screen.getByRole("option", { name: "Ollama" }))

    expect(within(sheet).getByLabelText("API base URL")).toHaveValue("http://host.docker.internal:11434/v1")
    expect(within(sheet).getByLabelText("Ollama API key (optional)")).toHaveValue("")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    await waitFor(() => expect(calls(fetchSpy, "PUT", "/api/settings/api-keys/ollama")).toHaveLength(1))
    expect(bodyOf(calls(fetchSpy, "PUT", "/api/settings/api-keys/ollama")[0]![1])).toEqual({
      baseUrl: "http://host.docker.internal:11434/v1",
    })
  })

  it("sends a custom host with a cloud provider key", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": noKeys,
      "PUT /api/settings/api-keys/anthropic": { key: storedAnthropic },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Add Connection" }))
    const sheet = await screen.findByRole("dialog")
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

    await userEvent.click(await screen.findByRole("button", { name: "Add Connection" }))
    const sheet = await screen.findByRole("dialog")
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-invalid")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and save" }))

    expect(await within(sheet).findByText("The API host rejected this key")).toBeInTheDocument()
    expect(sheet).toBeInTheDocument()
  })

  it("opens the stored provider and rechecks its status after replacement", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "PUT /api/settings/api-keys/anthropic": { key: storedAnthropic },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    expect(await screen.findByText("Active")).toBeInTheDocument()
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(1)
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/openai/status")).toHaveLength(0)
    const row = screen.getByRole("row", { name: /Anthropic/ })
    expect(within(row).getByText("••••1234")).toBeInTheDocument()
    expect(within(row).getByText("Default")).toBeInTheDocument()
    await userEvent.click(within(row).getByRole("button", { name: "Actions for Anthropic" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Replace" }))
    const sheet = await screen.findByRole("dialog")

    expect(within(sheet).getByRole("combobox", { name: "Provider" })).toHaveTextContent("Anthropic")
    expect(within(sheet).getByText(/A key ending in 1234 is stored/)).toBeInTheDocument()
    await userEvent.type(within(sheet).getByLabelText("Anthropic API key"), "sk-ant-replacement")
    await userEvent.click(within(sheet).getByRole("button", { name: "Check and replace" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() =>
      expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(2),
    )
  })

  it("lists a key the server can no longer decrypt so it can be replaced or removed", async () => {
    const unreadable = { ...storedAnthropic, last4: null, undecryptable: true }
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [unreadable, ...noKeys.keys.slice(1)] },
      "DELETE /api/settings/api-keys/anthropic": () => jsonResponse(204),
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    const row = await screen.findByRole("row", { name: /Anthropic/ })
    expect(within(row).getByText("Unreadable")).toBeInTheDocument()
    expect(within(row).getByText("Re-enter key")).toBeInTheDocument()
    expect(calls(fetchSpy, "GET", "/api/settings/api-keys/anthropic/status")).toHaveLength(0)

    await userEvent.click(within(row).getByRole("button", { name: "Actions for Anthropic" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Replace" }))
    const sheet = await screen.findByRole("dialog")
    expect(within(sheet).getByText(/The stored key can't be decrypted/)).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())

    await userEvent.click(within(row).getByRole("button", { name: "Actions for Anthropic" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove connection" }))

    await waitFor(() => expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(1))
  })

  it("removes a stored key after confirming", async () => {
    const fetchSpy = mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "DELETE /api/settings/api-keys/anthropic": () => jsonResponse(204),
    })
    renderWithProviders(<App />, { route: "/llm-connections" })

    await userEvent.click(await screen.findByRole("button", { name: "Actions for Anthropic" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("Remove Anthropic connection?")).toBeInTheDocument()
    expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(0)
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove connection" }))

    await waitFor(() => expect(calls(fetchSpy, "DELETE", "/api/settings/api-keys/anthropic")).toHaveLength(1))
  })

  it("searches and filters the stored connections", async () => {
    const storedOllama = {
      provider: "ollama",
      stored: true,
      last4: null,
      undecryptable: false,
      baseUrl: "http://ollama.internal:11434/v1",
      updatedAt: "2026-10-02T00:00:00.000Z",
      serverDefault: false,
    }
    mockApi({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1, 3), storedOllama] },
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "GET /api/settings/api-keys/ollama/status": { status: "unreachable" },
    })
    renderWithProviders(<App />, { route: "/llm-connections" })
    const providers = () => screen.getAllByRole("row").slice(1).map((row) => row.querySelector("td")?.textContent)
    await screen.findByText("••••1234")
    expect(providers()).toEqual(["Anthropic", "Ollama"])

    const search = screen.getByRole("searchbox", { name: "Search connections" })
    await userEvent.type(search, "ollama.internal")
    expect(providers()).toEqual(["Ollama"])
    await userEvent.type(search, "-nothing")
    expect(screen.getByText("No connections match your filters.")).toBeInTheDocument()
    await userEvent.clear(search)
    expect(providers()).toEqual(["Anthropic", "Ollama"])

    await chooseFilter("Provider", "Anthropic")
    expect(providers()).toEqual(["Anthropic"])
    await userEvent.keyboard("{Escape}")
    const chip = screen.getByRole("button", { name: "Remove Provider filter" })
    expect(chip.parentElement).toHaveTextContent("Provider: Anthropic")
    await userEvent.click(chip)
    expect(providers()).toEqual(["Anthropic", "Ollama"])

    await screen.findByText("Unknown")
    await chooseFilter("Status", "Unknown")
    expect(providers()).toEqual(["Ollama"])
  })

  describe("testing a model", () => {
    const routes = (result: unknown) => ({
      "GET /api/settings/api-keys": { keys: [storedAnthropic, ...noKeys.keys.slice(1)] },
      "GET /api/settings/api-keys/anthropic/status": { status: "active" },
      "GET /api/settings/api-keys/anthropic/models": { models: ["anthropic/claude-haiku-5-5", "anthropic/claude-sonnet-5-5"] },
      "POST /api/settings/api-keys/anthropic/test": result,
    })

    async function openTest() {
      await userEvent.click(await screen.findByRole("button", { name: "Actions for Anthropic" }))
      await userEvent.click(await screen.findByRole("menuitem", { name: "Test model" }))
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
})
