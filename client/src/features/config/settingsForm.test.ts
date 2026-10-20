import { describe, expect, it } from "vitest"
import type { ConfigSchema } from "./api"
import { INHERIT, baseConfig, isDirty, toForm, toSettings, validateForm, withoutDefaults } from "./settingsForm"

const schema: ConfigSchema = {
  defaults: {
    profile: "balanced",
    llm: {
      model: "anthropic/claude-sonnet-5-5",
      fallbackModels: [],
      walkthroughModel: null,
      verifyModel: null,
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
      findingCounts: true,
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
  },
  profiles: { balanced: {}, fast: { output: { walkthrough: false } }, strict: { review: { blockOn: "major" } } },
  severities: ["critical", "major", "minor"],
  categories: ["security", "bug", "style"],
}

describe("toSettings", () => {
  it("saves the walkthrough content switches, summary placement and instructions", () => {
    const form = toForm({})
    const next = {
      ...form,
      flags: { ...form.flags, sequenceDiagrams: false, relatedIssues: false, abortOnClose: false, disableCache: true },
      choices: { ...form.choices, highLevelSummaryPlacement: "walkthrough" },
      summaryInstructions: "  Bullets only  ",
    }
    const saved = toSettings({}, next)
    expect(saved).toEqual({
      review: { disableCache: true },
      output: {
        sequenceDiagrams: false,
        relatedIssues: false,
        highLevelSummaryPlacement: "walkthrough",
        highLevelSummaryInstructions: "Bullets only",
      },
      triggers: { abortOnClose: false },
    })
    expect(toForm(saved).summaryInstructions).toBe("Bullets only")
    expect(validateForm({ ...next, summaryInstructions: "x".repeat(2001) }).summaryInstructions).toBe("At most 2000 characters")
  })

  it("round-trips saved settings through the form", () => {
    const saved = {
      profile: "strict",
      llm: { model: "openai/gpt-5", walkthroughModel: "openai/gpt-5-mini", verifyModel: "openai/gpt-5.5" },
      review: { blockOn: "major", fullFile: true, verify: "all" as const },
      output: { walkthrough: false, postCheck: true },
      triggers: { review: "all" as const, reviewOnPush: false, command: false, skipLabels: ["no-review"] },
      instructions: "Keep it lean",
    }
    expect(toSettings(saved, toForm(saved))).toEqual(saved)
  })

  it("saves the trigger choices and skip lists", () => {
    const form = toForm({})
    expect(form.choices).toEqual({ review: INHERIT, summary: INHERIT, highLevelSummaryPlacement: INHERIT, verify: INHERIT })
    const next = {
      ...form,
      choices: { review: "manual", summary: "manual", highLevelSummaryPlacement: INHERIT, verify: INHERIT },
      lists: { ...form.lists, ignoreTitles: [" WIP", "Do not review ", " "], skipAuthors: ["dependabot[bot]"] },
    }
    expect(toSettings({}, next)).toEqual({
      triggers: {
        review: "manual",
        summary: "manual",
        ignoreTitles: ["WIP", "Do not review"],
        skipAuthors: ["dependabot[bot]"],
      },
    })
    expect(toForm(toSettings({}, next)).lists.ignoreTitles).toEqual(["WIP", "Do not review"])
  })

  it("reads the legacy trigger keys into the code review trigger and drops them on save", () => {
    expect(toForm({ triggers: { onPush: false } }).choices.review).toBe("manual")
    expect(toForm({ triggers: { drafts: true } }).choices.review).toBe("all")
    expect(toForm({ triggers: { onPush: false, review: "published" } }).choices.review).toBe("published")
    const legacy = { triggers: { onPush: false, drafts: true, command: false } }
    expect(toSettings(legacy, toForm(legacy))).toEqual({ triggers: { review: "manual", command: false } })
    expect(isDirty(legacy, toForm(legacy))).toBe(false)
  })

  it("round-trips every other field, including an explicit auto context budget", () => {
    const saved = {
      llm: { fallbackModels: ["openai/gpt-5", "google/gemini-3"], temperature: 0, maxTokens: 4000, contextBudget: null },
      review: { categories: ["style"], maxFindings: 10, maxChunks: 3, minConfidence: 0.75 },
      ignorePaths: ["gen/**", "**/*.{png,svg}"],
      languageInstructions: { Go: "Wrap errors", Python: "Type hints" },
    }
    const form = toForm(saved)
    expect(form.numbers.contextBudget).toBe("auto")
    expect(toSettings(saved, form)).toEqual(saved)
  })

  it("trims lists, keeps commas in globs and drops incomplete language rows", () => {
    const form = {
      ...toForm({}),
      fallbackModels: [" openai/gpt-5 ", "", "google/gemini-3"],
      ignorePaths: "  **/*.{png,svg}\n\n gen/** ",
      numbers: { ...toForm({}).numbers, maxFindings: " 12 " },
      languageInstructions: [
        { language: " Go ", text: " Wrap errors " },
        { language: "Rust", text: "  " },
      ],
    }

    expect(toSettings({}, form)).toEqual({
      llm: { fallbackModels: ["openai/gpt-5", "google/gemini-3"] },
      review: { maxFindings: 12 },
      ignorePaths: ["**/*.{png,svg}", "gen/**"],
      languageInstructions: { Go: "Wrap errors" },
    })
  })

  it("removes inherited values and empty sections but keeps keys the form does not show", () => {
    const saved = { review: { blockOn: "major", maxFindings: 10 }, output: { walkthrough: true }, ignorePaths: ["gen/**"] }
    const base = toForm(saved)
    const form = { ...base, blockOn: INHERIT, flags: { ...base.flags, walkthrough: undefined } }

    expect(toSettings(saved, form)).toEqual({ review: { maxFindings: 10 }, ignorePaths: ["gen/**"] })
  })

  it("saves flags turned off and trims text", () => {
    const base = toForm({})
    const form = {
      ...base,
      model: "  anthropic/claude-opus-5-5 ",
      instructions: "   ",
      flags: { ...base.flags, postInline: false, requireEvidence: false },
    }

    expect(toSettings({}, form)).toEqual({
      llm: { model: "anthropic/claude-opus-5-5" },
      review: { requireEvidence: false },
      output: { postInline: false },
    })
  })
})

describe("isDirty", () => {
  const saved = { output: { walkthrough: false }, instructions: "Keep it lean" }

  it("is clean for the saved settings and for edits that save the same thing", () => {
    expect(isDirty(saved, toForm(saved))).toBe(false)
    expect(isDirty(saved, { ...toForm(saved), instructions: "Keep it lean  " })).toBe(false)
  })

  it("is dirty once a value changes or a flag goes back to inheriting", () => {
    const form = toForm(saved)
    expect(isDirty(saved, { ...form, flags: { ...form.flags, reviewOnPush: false } })).toBe(true)
    expect(isDirty(saved, { ...form, choices: { ...form.choices, review: "all" } })).toBe(true)
    expect(isDirty(saved, { ...form, lists: { ...form.lists, skipLabels: [" "] } })).toBe(false)
    expect(isDirty(saved, { ...form, lists: { ...form.lists, skipLabels: ["no-review"] } })).toBe(true)
    expect(isDirty(saved, { ...form, flags: { ...form.flags, walkthrough: undefined } })).toBe(true)
  })
})

describe("baseConfig", () => {
  it("puts the profile's preset on top of the defaults", () => {
    const base = baseConfig(schema, "strict")
    expect(base.profile).toBe("strict")
    expect(base.review).toMatchObject({ blockOn: "major", severityFloor: "minor" })
    expect(baseConfig(schema).review.blockOn).toBe("critical")
  })
})

describe("withoutDefaults", () => {
  it("drops values the profile and defaults already give and keeps the rest", () => {
    const settings = {
      profile: "fast",
      llm: { model: "anthropic/claude-sonnet-5-5" },
      review: { blockOn: "critical", severityFloor: "major", maxFindings: 10 },
      output: { walkthrough: false, postInline: true },
      ignorePaths: ["gen/**"],
    }

    expect(withoutDefaults(settings, schema)).toEqual({
      profile: "fast",
      review: { severityFloor: "major", maxFindings: 10 },
      ignorePaths: ["gen/**"],
    })
  })

  it("compares lists by value", () => {
    const settings = {
      llm: { fallbackModels: [] },
      review: { categories: ["security", "bug"] },
      ignorePaths: ["**/*.lock"],
      languageInstructions: {},
    }
    expect(withoutDefaults(settings, schema)).toEqual({})
    expect(withoutDefaults({ review: { categories: ["bug"] } }, schema)).toEqual({ review: { categories: ["bug"] } })
  })

  it("drops the default profile and sections left empty", () => {
    expect(withoutDefaults({ profile: "balanced", triggers: { review: "published", skipLabels: [] } }, schema)).toEqual({})
  })

  it("lets isDirty ignore picking a value the defaults already give", () => {
    const form = { ...toForm({}), blockOn: "critical" }
    expect(isDirty({}, form, (settings) => withoutDefaults(settings, schema))).toBe(false)
    expect(isDirty({}, form)).toBe(true)
  })
})

describe("validateForm", () => {
  const form = toForm({})

  it("accepts an untouched form and auto", () => {
    expect(validateForm(form)).toEqual({})
    expect(validateForm({ ...form, numbers: { ...form.numbers, contextBudget: "auto" } })).toEqual({})
  })

  it("reports values the server would reject", () => {
    const errors = validateForm({
      ...form,
      model: "claude",
      walkthroughModel: "haiku",
      verifyModel: "anthropic/claude-opus-5-5",
      fallbackModels: ["openai/a", "openai/b", "openai/c", "openai/d"],
      categories: [],
      numbers: { ...form.numbers, temperature: "2", maxTokens: "1.5", contextBudget: "lots" },
      languageInstructions: [
        { language: "Go", text: "a" },
        { language: "go", text: "b" },
      ],
      lists: {
        ...form.lists,
        skipAuthors: Array.from({ length: 51 }, (_, i) => `bot${i}`),
        skipLabels: ["x".repeat(201)],
      },
    })

    expect(errors).toEqual({
      model: 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5',
      walkthroughModel: 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5',
      fallbackModels: "At most 3 fallback models",
      categories: "Choose at least one category",
      temperature: "Must be between 0 and 1",
      maxTokens: "Enter a whole number",
      contextBudget: 'Enter a whole number or "auto"',
      languageInstructions: "Each language can only be listed once",
      skipAuthors: "At most 50 entries",
      skipLabels: "At most 200 characters per entry",
    })
  })

  it("accepts router model ids", () => {
    expect(
      validateForm({
        ...form,
        model: "openai/cx/gpt-5.6-sol(medium)",
      }),
    ).toEqual({})
  })

  it("accepts Ollama model ids", () => {
    expect(validateForm({ ...form, model: "ollama/qwen3" })).toEqual({})
  })
})

describe("LLM connection", () => {
  it("round-trips a live connection reference", () => {
    const form = { ...toForm({}), connection: "openai" }
    const settings = toSettings({}, form)
    expect(settings).toEqual({ llm: { connection: "openai" } })
    expect(toForm(settings).connection).toBe("openai")
    expect(toSettings(settings, { ...form, connection: INHERIT })).toEqual({})
  })

  it("converts a legacy endpoint key and removes copied endpoint values", () => {
    const legacy = { llm: { baseUrl: "http://localhost:20128/v1", endpointKey: "openai" as const } }
    const form = toForm(legacy)
    expect(form.connection).toBe("openai")
    expect(toSettings(legacy, form)).toEqual({ llm: { connection: "openai" } })
  })

  it("requires a connection for the global form", () => {
    expect(validateForm(toForm({}), true)).toMatchObject({ connection: "Select an LLM connection" })
  })
})
