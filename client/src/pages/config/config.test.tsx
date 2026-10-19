import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi } from "@/test/apiRoutes"

const effective = {
  profile: "balanced",
  llm: {
    model: "anthropic/claude-sonnet-5-5",
    fallbackModels: [],
    temperature: 0.2,
    maxTokens: 8000,
    contextBudget: null,
    connection: null,
    baseUrl: null,
    endpointKey: null,
  },
  review: {
    categories: ["security", "bug"],
    severityFloor: "minor",
    blockOn: "critical",
    maxFindings: 25,
    maxChunks: 12,
    minConfidence: 0.5,
    requireEvidence: true,
    suppressIgnored: true,
    fullFile: false,
    committableSuggestions: true,
    disableCache: false,
    fileContext: true,
    verify: "blocking",
    toolFindings: true,
    toolFindingsBlock: false,
  },
  output: {
    walkthrough: true,
    postInline: true,
    postSummary: true,
    postCheck: true,
    resolveFixedThreads: true,
    reviewStats: true,
    agentPrompts: true,
    agentPromptAll: true,
    blastRadiusLabel: false,
    effortLabel: false,
    sequenceDiagrams: true,
    estimateEffort: true,
    assessLinkedIssues: true,
    relatedIssues: true,
    highLevelSummary: true,
    highLevelSummaryPlacement: "description",
    highLevelSummaryInstructions: "",
  },
  triggers: {
    review: "published",
    reviewOnPush: true,
    fullReviewOnPush: false,
    summary: "published",
    command: true,
    abortOnClose: true,
    ignoreTitles: [],
    skipAuthors: [],
    skipLabels: [],
    skipSourceBranches: [],
    skipTargetBranches: [],
    onPush: true,
    drafts: false,
  },
  ignorePaths: ["**/*.lock"],
  instructions: "",
  languageInstructions: {},
}

const globalConfig = (settings: Record<string, unknown> = {}, sources: Record<string, string> = {}) => ({
  settings,
  warnings: [],
  config: effective,
  sources: { profile: "default", "llm.model": "default", "review.blockOn": "default", ...sources },
})

const schema = {
  defaults: effective,
  profiles: { balanced: {}, strict: { review: { blockOn: "major" } } },
  severities: ["critical", "major", "minor"],
  categories: ["security", "bug", "style"],
}

const repo = (id: string, fullPath: string, extra: Record<string, unknown> = {}) => ({
  id,
  connectionId: "c1",
  account: { login: "dev", provider: "gitlab", host: "gitlab.com" },
  externalId: id,
  fullPath,
  defaultBranch: "main",
  webUrl: `https://gitlab.com/${fullPath}`,
  enabled: true,
  settings: {},
  followGlobal: true,
  ...extra,
})

async function chooseScope(name: string | RegExp) {
  await userEvent.click(await screen.findByRole("combobox", { name: "Scope" }))
  await userEvent.click(await screen.findByRole("option", { name }))
}

async function openTab(name: string) {
  await userEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${name}`) }))
}

async function choosePreviewView(preview: HTMLElement, name: "Summary" | "In-line") {
  await userEvent.click(within(preview).getByRole("combobox", { name: "View" }))
  await userEvent.click(screen.getByRole("option", { name }))
}

async function selectConnectionOnLlmTab() {
  await openTab("LLM Config")
  await selectOpenAiConnection()
}

async function selectOpenAiConnection() {
  await userEvent.click(screen.getByRole("combobox", { name: "LLM connection" }))
  await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))
}

const GLOBAL_SCOPE = /The global config applies to every repository/
// A server preview of the sample change, trimmed to what the tests look at.
const PREVIEW = {
  provider: "github",
  pr: {
    title: "Add user lookup endpoint",
    number: 42,
    author: "ada",
    sourceBranch: "feature/user-lookup",
    targetBranch: "main",
    labels: ["Medium blast radius"],
  },
  status: { state: "failure", description: "1 finding at or above critical" },
  summaryComment:
    "## Summary\n\nAdds a lookup endpoint.\n\n⛔ **Blocked**: 1 finding at or above critical.\n\n<details>\n<summary>Actionable comments (1)</summary>\n\n- SQL\n\n</details>\n\n<!-- sentryward:summary -->\n",
  walkthroughComment: null,
  inline: [
    {
      path: "src/api/users.ts",
      startLine: 9,
      endLine: 9,
      body: "**critical** · security\n\n**User id is interpolated**\n\n```suggestion\nconst rows = safe()\n```",
      diff: [{ type: "add", oldLine: null, newLine: 9, text: "const rows = old()" }],
    },
  ],
}
const NOTHING = { summaryComment: null, walkthroughComment: null, status: null, inline: [] }

interface PreviewBody {
  provider: string
  base: Record<string, unknown>
  settings: Record<string, unknown>
}

// Records each preview request and answers like the server would for the
// switches the tests use.
function previewStub(bodies: PreviewBody[]) {
  return (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as PreviewBody
    bodies.push(body)
    const output = (body.settings.output ?? {}) as Record<string, boolean>
    return jsonResponse(200, {
      ...PREVIEW,
      provider: body.provider,
      inline: output.postInline === false ? [] : PREVIEW.inline,
    })
  }
}

const globalRoutes = (extra: Record<string, unknown> = {}) => ({
  "POST /api/config/preview": PREVIEW,
  "GET /api/config/global": globalConfig(),
  "GET /api/config/schema": schema,
  "GET /api/repos": { repos: [] },
  "GET /api/settings/api-keys": {
    keys: [
      { provider: "anthropic", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: true },
      { provider: "openai", stored: true, last4: "9rtr", baseUrl: null, updatedAt: "2026-10-04T00:00:00Z", serverDefault: false },
      { provider: "google", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: false },
      { provider: "ollama", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: false },
    ],
  },
  ...extra,
})

describe("Configuration page", () => {
  it("is linked from the sidebar", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/home" })

    await userEvent.click(await screen.findByRole("link", { name: "Configuration" }))

    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    expect(await screen.findByRole("tab", { name: /^LLM Config/, selected: true })).toBeInTheDocument()
  })

  it("splits the settings into tabs and keeps the open tab in the URL", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    expect(await screen.findByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
    expect(screen.getByLabelText("Ignore paths")).toBeInTheDocument()
    expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "LLM Config, has errors",
      "Finding Types",
      "Files",
      "Display",
      "Triggers",
      "Guidance",
    ])

    await openTab("LLM Config")
    for (const name of ["Connection", "Models", "Model calls"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    await openTab("Finding Types")
    for (const name of ["Severity", "What gets reported", "Review rules"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }

    await openTab("Triggers")
    expect(screen.getByRole("switch", { name: "Allow review command" })).toBeInTheDocument()
    expect(screen.queryByLabelText("Ignore paths")).not.toBeInTheDocument()
  })

  it("saves the global config and shows where effective values come from", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig({ llm: { model: "openai/gpt-5" } }, { "llm.model": "global" }))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText("Effective: anthropic/claude-sonnet-5-5 (from default)")).toBeInTheDocument()
    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({ settings: { llm: { model: "openai/gpt-5", connection: "openai" } } }),
    )
    expect(await screen.findByText("Global config saved")).toBeInTheDocument()
  })

  it("shows real values instead of inherit in the global config and only saves changes", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    const save = await screen.findByRole("button", { name: "Save global config" })
    // Picking the value the defaults already give is not a change.
    const profile = screen.getByRole("combobox", { name: "Profile" })
    await waitFor(() => expect(profile).toHaveTextContent("balanced"))
    await userEvent.click(profile)
    await userEvent.click(screen.getByRole("option", { name: "balanced" }))
    expect(save).toBeDisabled()
    await selectOpenAiConnection()

    // A profile's preset shows through on the other tabs without being pinned.
    await userEvent.click(profile)
    await userEvent.click(screen.getByRole("option", { name: "strict" }))
    await openTab("Finding Types")
    const blockOn = screen.getByRole("combobox", { name: "Block at or above" })
    expect(blockOn).toHaveTextContent("major")
    await userEvent.click(blockOn)
    expect(screen.queryByRole("option", { name: /Inherit/ })).not.toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await openTab("Display")
    const walkthrough = screen.getByRole("switch", { name: "Walkthrough" })
    expect(walkthrough).toBeChecked()
    await userEvent.click(walkthrough)
    expect(walkthrough).not.toBeChecked()
    expect(screen.queryByText("Overridden")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /to inherited/ })).not.toBeInTheDocument()
    // Edits from every tab go out in one save.
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: { profile: "strict", llm: { connection: "openai" }, output: { walkthrough: false } },
      }),
    )
  })

  it("edits every kind of setting in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.type(await screen.findByLabelText("Context budget"), "auto")
    await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
    await userEvent.type(screen.getByLabelText("Fallback model 1"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("combobox", { name: "LLM connection" }))
    // Only connections saved by this user are offered, not server defaults.
    expect(screen.queryByRole("option", { name: /Anthropic/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("option", { name: /Google/ })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }))

    await openTab("Finding Types")
    expect(screen.getByRole("checkbox", { name: "security" })).toBeChecked()
    expect(screen.getByRole("checkbox", { name: "style" })).not.toBeChecked()
    await userEvent.type(screen.getByLabelText("Max findings"), "10")
    await userEvent.click(screen.getByRole("checkbox", { name: "bug" }))
    await userEvent.click(screen.getByRole("checkbox", { name: "style" }))

    await openTab("Files")
    await userEvent.type(screen.getByLabelText("Ignore paths"), "gen/**{enter}docs/**")

    await openTab("Guidance")
    await userEvent.click(screen.getByRole("button", { name: "Add language" }))
    await userEvent.type(screen.getByLabelText("Language 1"), "Go")
    await userEvent.type(screen.getByLabelText("Guidance for language 1"), "Wrap errors")
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          // "auto" is already the default context budget, so it is not pinned.
          llm: {
            fallbackModels: ["openai/gpt-5"],
            connection: "openai",
          },
          review: { categories: ["security", "style"], maxFindings: 10 },
          ignorePaths: ["gen/**", "docs/**"],
          languageInstructions: { Go: "Wrap errors" },
        },
      }),
    )
  })

  it("edits the trigger settings in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=triggers" })

    // The global config shows real values: the defaults until something is picked.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Code review trigger" })).toHaveTextContent("Published PRs"),
    )
    for (const name of ["Code reviews", "Skip rules"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    for (const name of ["Review automatically on push", "Allow review command"]) {
      expect(screen.getByRole("switch", { name })).toBeInTheDocument()
    }
    // What gets posted, and where, lives on the Display tab.
    expect(screen.queryByRole("combobox", { name: "Comment location" })).not.toBeInTheDocument()
    expect(screen.queryByRole("switch", { name: "Publish blast radius label" })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole("combobox", { name: "Code review trigger" }))
    await userEvent.click(screen.getByRole("option", { name: "Draft and published PRs" }))
    await userEvent.click(screen.getByRole("combobox", { name: "PR summary trigger" }))
    await userEvent.click(screen.getByRole("option", { name: "Manual only" }))
    await userEvent.click(screen.getByRole("switch", { name: "Review automatically on push" }))
    await userEvent.type(screen.getByLabelText("Ignore by title"), "WIP{enter}Draft,")
    // "[[" types a literal bracket.
    await userEvent.type(screen.getByLabelText("Skip by author"), "dependabot[[bot]{enter}")
    await userEvent.type(screen.getByLabelText("Skip by label"), "no-review{enter}")
    await userEvent.type(screen.getByLabelText("Skip by source branch"), "release/{enter}")
    // Left in the box: it is added when the box loses focus.
    await userEvent.type(screen.getByLabelText("Skip by target branch"), "legacy")
    expect(screen.getByRole("button", { name: "Remove Draft" })).toBeInTheDocument()

    await openTab("Display")
    await userEvent.click(screen.getByRole("switch", { name: "Show review details" }))
    await userEvent.click(screen.getByRole("switch", { name: "Prompt for AI agents per comment" }))
    await userEvent.click(screen.getByRole("switch", { name: "Publish blast radius label" }))
    await userEvent.click(screen.getByRole("switch", { name: "Publish review time estimate label" }))
    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          output: { reviewStats: false, agentPrompts: false, blastRadiusLabel: true, effortLabel: true },
          triggers: {
            review: "all",
            reviewOnPush: false,
            summary: "manual",
            ignoreTitles: ["WIP", "Draft"],
            skipAuthors: ["dependabot[bot]"],
            skipLabels: ["no-review"],
            skipSourceBranches: ["release/"],
            skipTargetBranches: ["legacy"],
          },
        },
      }),
    )
  })

  it("edits the walkthrough content, summary and run settings in the global config", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig((body as { settings: Record<string, unknown> }).settings))
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    await waitFor(() => expect(screen.getByRole("switch", { name: "Sequence diagrams" })).toBeChecked())
    for (const name of ["Estimate code review effort", "Assess linked issues", "Related issues", "High-level summary"]) {
      expect(screen.getByRole("switch", { name })).toBeChecked()
    }
    await userEvent.click(screen.getByRole("switch", { name: "Sequence diagrams" }))
    await userEvent.click(screen.getByRole("switch", { name: "Related issues" }))
    await userEvent.click(screen.getByRole("combobox", { name: "Summary placement" }))
    await userEvent.click(screen.getByRole("option", { name: "Walkthrough" }))
    await userEvent.type(screen.getByLabelText("High level summary instructions"), "Bullets only")

    // Without a summary there is nothing to place or instruct.
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))
    expect(screen.getByLabelText("High level summary instructions")).toBeDisabled()
    await userEvent.click(screen.getByRole("switch", { name: "High-level summary" }))

    await openTab("Triggers")
    await userEvent.click(screen.getByRole("switch", { name: "Abort on close" }))
    await openTab("Files")
    await userEvent.click(screen.getByRole("switch", { name: "Disable cache" }))
    await selectConnectionOnLlmTab()
    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))

    await waitFor(() =>
      expect(body).toEqual({
        settings: {
          llm: { connection: "openai" },
          review: { disableCache: true },
          output: {
            sequenceDiagrams: false,
            relatedIssues: false,
            highLevelSummaryPlacement: "walkthrough",
            highLevelSummaryInstructions: "Bullets only",
          },
          triggers: { abortOnClose: false },
        },
      }),
    )
  })

  it("requires a saved LLM connection and links to the LLM Connections page", async () => {
    mockApi(
      globalRoutes({
        "GET /api/settings/api-keys": {
          keys: [
            { provider: "anthropic", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: true },
            { provider: "openai", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: false },
            { provider: "google", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: false },
            { provider: "ollama", stored: false, last4: null, baseUrl: null, updatedAt: null, serverDefault: false },
          ],
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText("Select an LLM connection")).toBeInTheDocument()
    // Scoped to the page (the innermost main): the sidebar has its own LLM Connections link.
    const page = screen.getAllByRole("main").at(-1)!
    await waitFor(() => expect(within(page).getAllByRole("link", { name: "LLM Connections" })).toHaveLength(2))
    const links = within(page).getAllByRole("link", { name: "LLM Connections" })
    expect(links[1]!.closest("p")).toHaveTextContent("No saved connections")
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/llm-connections")
    }
    expect(screen.getByRole("button", { name: "Save global config" })).toBeDisabled()
  })

  it("holds back a save while a value is out of range and marks the tab", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=files" })

    await openTab("LLM Config")
    await selectOpenAiConnection()
    await openTab("Files")
    await userEvent.type(await screen.findByLabelText("Max chunks"), "500")

    expect(screen.getByText("Must be between 1 and 50")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files, has errors" })).toBeInTheDocument()
    // Still held back from a tab without the error.
    await openTab("Display")
    expect(screen.getByRole("button", { name: "Save global config" })).toBeDisabled()

    await openTab("Files")
    await userEvent.clear(screen.getByLabelText("Max chunks"))
    await userEvent.type(screen.getByLabelText("Max chunks"), "20")
    expect(screen.getByRole("tab", { name: "Files" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save global config" })).toBeEnabled()
  })

  it("renders what the server previews as the PR page, following unsaved edits", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    for (const name of ["Review comments", "PR summary"]) {
      expect(screen.getByRole("group", { name })).toBeInTheDocument()
    }
    // The settings and the preview are separate cards.
    expect(screen.getByRole("switch", { name: "Walkthrough" }).closest("[data-slot=card]")).not.toBe(
      preview.closest("[data-slot=card]"),
    )

    expect(await within(preview).findByRole("heading", { name: /Add user lookup endpoint/ })).toHaveTextContent("#42")
    // Sentryward never writes to the description, so the preview leaves it out.
    expect(within(preview).queryByRole("region", { name: "Pull request description" })).not.toBeInTheDocument()
    expect(within(preview).getByRole("list", { name: "Labels" })).toHaveTextContent("Medium blast radius")
    // The summary view is shown first, without the inline threads.
    expect(within(preview).getByRole("combobox", { name: "View" })).toHaveTextContent("Summary")
    const summary = within(preview).getByRole("region", { name: "Summary comment" })
    expect(within(preview).queryByRole("region", { name: "Inline comments" })).not.toBeInTheDocument()
    expect(within(summary).getByRole("heading", { name: "Summary" })).toBeInTheDocument()
    expect(summary).toHaveTextContent("Adds a lookup endpoint.")
    // Sentryward no longer offers to write into the PR/MR description.
    expect(screen.queryByRole("combobox", { name: "Comment location" })).not.toBeInTheDocument()
    // Hidden markers stay hidden, as on the forge.
    expect(preview).not.toHaveTextContent("sentryward:summary")
    expect(within(preview).getByRole("region", { name: "Commit status" })).toHaveTextContent(
      "Failing: 1 finding at or above critical",
    )
    expect(bodies.at(-1)).toMatchObject({ provider: "github", base: { review: { blockOn: "critical" } } })

    const sent = bodies.length
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByRole("region", { name: "Inline comments" })).toBeInTheDocument()
    expect(within(preview).queryByRole("region", { name: "Summary comment" })).not.toBeInTheDocument()
    expect(within(preview).queryByRole("region", { name: "Commit status" })).not.toBeInTheDocument()
    // Switching views reuses the loaded preview.
    expect(bodies).toHaveLength(sent)
    const suggestion = within(preview).getByRole("group", { name: "Suggested change" })
    expect(suggestion).toHaveTextContent("- const rows = old()")
    expect(suggestion).toHaveTextContent("Commit suggestion")

    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    await waitFor(() => expect(within(preview).queryByRole("region", { name: "Inline comments" })).not.toBeInTheDocument())
    expect(bodies.at(-1)?.settings).toEqual({ output: { postInline: false } })
  })

  it("switches the page between GitHub and GitLab", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    const forge = within(preview).getByRole("combobox", { name: "Forge" })
    expect(forge).toHaveTextContent("GitHub")
    await userEvent.click(forge)
    await userEvent.click(screen.getByRole("option", { name: "GitLab" }))

    expect(await within(preview).findByText("!42")).toBeInTheDocument()
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByRole("group", { name: "Suggested change" })).toHaveTextContent("Apply suggestion")
    expect(bodies.at(-1)?.provider).toBe("gitlab")
  })

  it("offers the agent prompts only while the comment that holds them is posted", async () => {
    mockApi(globalRoutes())
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    // Everything is disabled until the config has loaded.
    const perComment = await screen.findByRole("switch", { name: "Prompt for AI agents per comment" })
    await waitFor(() => expect(perComment).toBeEnabled())
    const all = screen.getByRole("switch", { name: "Prompt for all review comments" })
    expect(all).toBeEnabled()

    await userEvent.click(screen.getByRole("switch", { name: "Post inline comments" }))
    expect(perComment).toBeDisabled()
    expect(all).toBeEnabled()
    await userEvent.click(screen.getByRole("switch", { name: "Post summary comment" }))
    expect(all).toBeDisabled()
  })

  it("shows one example inline thread", async () => {
    const second = { ...PREVIEW.inline[0]!, path: "src/api/orders.ts", startLine: 3, endLine: 3 }
    mockApi(globalRoutes({ "POST /api/config/preview": { ...PREVIEW, inline: [...PREVIEW.inline, second] } }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    await choosePreviewView(preview, "In-line")

    expect(within(preview).getAllByRole("group", { name: "Suggested change" })).toHaveLength(1)
    expect(within(preview).getByText("src/api/users.ts")).toBeInTheDocument()
    expect(within(preview).queryByText("src/api/orders.ts")).not.toBeInTheDocument()
    expect(within(preview).getByText(/One example/)).toBeInTheDocument()
  })

  it("says when nothing is posted", async () => {
    mockApi(globalRoutes({ "POST /api/config/preview": { ...PREVIEW, pr: { ...PREVIEW.pr, labels: [] }, ...NOTHING } }))
    renderWithProviders(<App />, { route: "/configuration?tab=display" })

    const preview = await screen.findByRole("region", { name: "Review preview" })
    expect(await within(preview).findByText(/Sentryward posts no summary to the change/)).toBeInTheDocument()
    expect(within(preview).queryByText("No description provided.")).not.toBeInTheDocument()
    await choosePreviewView(preview, "In-line")
    expect(within(preview).getByText("Sentryward posts no inline comments on the diff.")).toBeInTheDocument()
  })

  it("sends the finding settings, and holds the preview while a value is invalid", async () => {
    const bodies: PreviewBody[] = []
    mockApi(globalRoutes({ "POST /api/config/preview": previewStub(bodies) }))
    renderWithProviders(<App />, { route: "/configuration?tab=findings" })

    await userEvent.click(await screen.findByRole("combobox", { name: "Block at or above" }))
    await userEvent.click(screen.getByRole("option", { name: "major" }))
    await userEvent.click(screen.getByRole("switch", { name: "Committable suggestions" }))
    await openTab("Display")
    const preview = screen.getByRole("region", { name: "Review preview" })
    await within(preview).findByText("#42")
    expect(bodies.at(-1)?.settings).toEqual({ review: { blockOn: "major", committableSuggestions: false } })

    await openTab("Finding Types")
    await userEvent.type(screen.getByLabelText("Max findings"), "0")
    await openTab("Display")
    const sent = bodies.length
    expect(
      within(screen.getByRole("region", { name: "Review preview" })).getByText(/Fix the highlighted fields/),
    ).toBeInTheDocument()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(bodies).toHaveLength(sent)
  })

  it("resets the global config with an empty object", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig(
          { profile: "strict", llm: { connection: "openai" } },
          { profile: "global", "llm.connection": "global" },
        ),
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig())
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("button", { name: "Reset to defaults" }))

    await waitFor(() => expect(body).toEqual({ settings: { llm: { connection: "openai" } } }))
  })

  it("switches between the global config and a repository on the same tab", async () => {
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: [repo("r2", "team/api"), repo("r1", "team/web")] },
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    await openTab("Files")
    await chooseScope(/team\/web/)

    expect(await screen.findByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
    expect(screen.queryByText(GLOBAL_SCOPE)).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeInTheDocument()

    await chooseScope("All repositories")
    expect(await screen.findByText(GLOBAL_SCOPE)).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Files", selected: true })).toBeInTheDocument()
  })

  it("searches the scope list once there are many repositories", async () => {
    const names = ["api", "cli", "docs", "infra", "mobile", "web", "worker"]
    mockApi(
      globalRoutes({
        "GET /api/repos": { repos: names.map((name) => repo(name, `team/${name}`)) },
        "GET /api/repos/web/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await userEvent.click(await screen.findByRole("combobox", { name: "Scope" }))
    await userEvent.type(screen.getByPlaceholderText("Search repositories..."), "web")

    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["team/webdev"])
    await userEvent.keyboard("{Enter}")

    expect(await screen.findByRole("switch", { name: "Follow global config for team/web" })).toBeInTheDocument()
  })

  it("opens a repository from a ?repo= link and toggles whether it follows the global config", async () => {
    let following = true
    let patched: unknown
    mockApi(
      globalRoutes({
        "GET /api/repos": () => jsonResponse(200, { repos: [repo("r1", "team/web", { followGlobal: following })] }),
        "GET /api/repos/r1/config": { ref: "main", repoFile: null, warnings: [], config: effective, sources: {} },
        "PATCH /api/repos/r1": (init?: RequestInit) => {
          patched = JSON.parse(String(init?.body))
          following = false
          return jsonResponse(200, { repo: repo("r1", "team/web", { followGlobal: false }) })
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=display" })

    const toggle = await screen.findByRole("switch", { name: "Follow global config for team/web" })
    expect(toggle).toBeChecked()
    expect(screen.getByRole("switch", { name: "Post inline comments" })).toBeDisabled()
    await userEvent.click(toggle)

    await waitFor(() => expect(patched).toEqual({ followGlobal: false }))
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(screen.getByRole("switch", { name: "Post inline comments" })).toBeEnabled()
  })

  it("locks a following repository's overrides and saves them once it stops following", async () => {
    let following = true
    let patched: unknown
    mockApi(
      globalRoutes({
        "GET /api/repos": () => jsonResponse(200, { repos: [repo("r1", "team/web", { followGlobal: following })] }),
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: effective,
          sources: { "review.blockOn": "global" },
        },
        "PATCH /api/repos/r1": (init?: RequestInit) => {
          const body = JSON.parse(String(init?.body))
          if ("followGlobal" in body) following = body.followGlobal
          else patched = body
          return jsonResponse(200, { repo: repo("r1", "team/web", { followGlobal: following }) })
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await chooseScope(/team\/web/)
    await openTab("Finding Types")
    expect(await screen.findByText("Effective: critical (from global config)")).toBeInTheDocument()
    await openTab("LLM Config")
    expect(screen.getByLabelText("Model")).toBeDisabled()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled()

    await userEvent.click(screen.getByRole("switch", { name: "Follow global config for team/web" }))
    await waitFor(() => expect(screen.getByLabelText("Model")).toBeEnabled())
    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-5")
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }))

    await waitFor(() => expect(patched).toEqual({ settings: { llm: { model: "openai/gpt-5" } } }))
  })

  it("explains inherit in a repository and resets a saved override to the global value", async () => {
    mockApi(
      globalRoutes({
        "GET /api/config/global": globalConfig({}, { "review.blockOn": "global" }),
        "GET /api/repos": {
          repos: [repo("r1", "team/web", { followGlobal: false, settings: { output: { walkthrough: false } } })],
        },
        "GET /api/repos/r1/config": {
          ref: "main",
          repoFile: null,
          warnings: [],
          config: { ...effective, output: { ...effective.output, walkthrough: false } },
          sources: { "output.walkthrough": "repoSettings" },
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration?repo=r1&tab=findings" })

    expect(await screen.findByText(/keeps following it when the global config changes/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole("combobox", { name: "Block at or above" }))
    expect(screen.getByRole("option", { name: /^Inherit\s*critical \(from global config\)$/ })).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await openTab("Display")
    const walkthrough = screen.getByRole("switch", { name: "Walkthrough" })
    expect(walkthrough).not.toBeChecked()
    expect(screen.getByText("Overridden")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Reset Walkthrough to inherited" }))

    // Back to what the global config gives, not the saved override.
    expect(walkthrough).toBeChecked()
    expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled()
  })
})

describe("Model pickers", () => {
  const openAiModels = { "GET /api/settings/api-keys/openai/models": { models: ["openai/gpt-5", "openai/gpt-5-mini"] } }

  it("offers the selected connection's models for the model and fallback models", async () => {
    let body: unknown
    mockApi(
      globalRoutes({
        ...openAiModels,
        "PUT /api/config/global": (init?: RequestInit) => {
          body = JSON.parse(String(init?.body))
          return jsonResponse(200, globalConfig())
        },
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5 (from default)")
    // No connection yet, so there is nothing to list.
    expect(screen.queryByRole("button", { name: "Choose model from the connection" })).not.toBeInTheDocument()
    await selectOpenAiConnection()

    await userEvent.click(screen.getByRole("button", { name: "Choose model from the connection" }))
    await userEvent.click(await screen.findByRole("option", { name: "openai/gpt-5" }))
    expect(screen.getByLabelText("Model")).toHaveValue("openai/gpt-5")

    await userEvent.click(screen.getByRole("button", { name: "Add fallback model" }))
    await userEvent.click(screen.getByRole("button", { name: "Choose Fallback model 1 from the connection" }))
    await userEvent.click(await screen.findByRole("option", { name: "openai/gpt-5-mini" }))
    expect(screen.getByLabelText("Fallback model 1")).toHaveValue("openai/gpt-5-mini")

    await userEvent.click(screen.getByRole("button", { name: "Save global config" }))
    await waitFor(() =>
      expect(body).toEqual({
        settings: { llm: { model: "openai/gpt-5", fallbackModels: ["openai/gpt-5-mini"], connection: "openai" } },
      }),
    )
  })

  it("still accepts a typed model when the connection's models cannot be loaded", async () => {
    mockApi(
      globalRoutes({
        "GET /api/settings/api-keys/openai/models": () => jsonResponse(400, { message: "Connection failed" }),
      }),
    )
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5 (from default)")
    await selectOpenAiConnection()
    await userEvent.click(screen.getByRole("button", { name: "Choose model from the connection" }))
    expect(await screen.findByText(/Could not load models from this connection/)).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")

    await userEvent.type(screen.getByLabelText("Model"), "openai/gpt-custom")
    expect(screen.getByLabelText("Model")).toHaveValue("openai/gpt-custom")
  })

  it("warns when an official connection cannot run a model", async () => {
    mockApi(globalRoutes(openAiModels))
    renderWithProviders(<App />, { route: "/configuration" })

    await screen.findByText("Effective: anthropic/claude-sonnet-5-5 (from default)")
    await selectOpenAiConnection()
    await userEvent.type(screen.getByLabelText("Model"), "anthropic/claude-sonnet-5-5")

    expect(screen.getByText("The OpenAI connection can only run openai/... models.")).toBeInTheDocument()
  })
})
