import type { ConfigOverride, ConfigSchema, EffectiveConfig } from "./api"

export const INHERIT = "__inherit"

// Every boolean the form edits, keyed by where it lives in a config.
export const FLAGS = [
  { name: "requireEvidence", section: "review" },
  { name: "suppressIgnored", section: "review" },
  { name: "fullFile", section: "review" },
  { name: "committableSuggestions", section: "review" },
  { name: "disableCache", section: "review" },
  { name: "fileContext", section: "review" },
  { name: "walkthrough", section: "output" },
  { name: "postInline", section: "output" },
  { name: "postSummary", section: "output" },
  { name: "postCheck", section: "output" },
  { name: "resolveFixedThreads", section: "output" },
  { name: "reviewStats", section: "output" },
  { name: "agentPrompts", section: "output" },
  { name: "agentPromptAll", section: "output" },
  { name: "blastRadiusLabel", section: "output" },
  { name: "effortLabel", section: "output" },
  { name: "sequenceDiagrams", section: "output" },
  { name: "estimateEffort", section: "output" },
  { name: "assessLinkedIssues", section: "output" },
  { name: "relatedIssues", section: "output" },
  { name: "highLevelSummary", section: "output" },
  { name: "reviewOnPush", section: "triggers" },
  { name: "fullReviewOnPush", section: "triggers" },
  { name: "command", section: "triggers" },
  { name: "abortOnClose", section: "triggers" },
] as const

export type FlagName = (typeof FLAGS)[number]["name"]
export type FlagSection = (typeof FLAGS)[number]["section"]

// Every select the form edits besides the profile, connection and severities.
export const CHOICES = [
  { name: "review", section: "triggers" },
  { name: "summary", section: "triggers" },
  { name: "highLevelSummaryPlacement", section: "output" },
  { name: "verify", section: "review" },
] as const

export type ChoiceName = (typeof CHOICES)[number]["name"]

// The skip lists, edited as tags.
export const LISTS = ["ignoreTitles", "skipAuthors", "skipLabels", "skipSourceBranches", "skipTargetBranches"] as const
export type ListName = (typeof LISTS)[number]
// Mirror server/src/review/config/schema.ts.
const MAX_LIST_ENTRIES = 50
const MAX_LIST_ENTRY = 200

export type NumberName = "temperature" | "maxTokens" | "contextBudget" | "maxFindings" | "maxChunks" | "minConfidence"

export interface NumberSpec {
  name: NumberName
  section: "llm" | "review"
  min: number
  max?: number
  step: number
  integer: boolean
  // Accepts AUTO, saved as null.
  nullable?: boolean
}

// Bounds mirror server/src/review/config/schema.ts so a bad value is caught
// before the server rejects the whole save.
export const NUMBERS: NumberSpec[] = [
  { name: "temperature", section: "llm", min: 0, max: 1, step: 0.1, integer: false },
  { name: "maxTokens", section: "llm", min: 1000, max: 64000, step: 1000, integer: true },
  { name: "contextBudget", section: "llm", min: 4000, step: 1000, integer: true, nullable: true },
  { name: "maxFindings", section: "review", min: 1, max: 100, step: 1, integer: true },
  { name: "maxChunks", section: "review", min: 1, max: 50, step: 1, integer: true },
  { name: "minConfidence", section: "review", min: 0, max: 1, step: 0.05, integer: false },
]

// Typed into the context budget to derive it from the model's context window.
export const AUTO = "auto"

// Router ids such as "openai/cx/gpt-5.6-sol(medium)" keep slashes and
// parentheses in the model part.
export const MODEL_PATTERN = /^(anthropic|openai|google|ollama)\/[\w.:()/-]+$/
export const MAX_FALLBACK_MODELS = 3
const MAX_IGNORE_PATHS = 200
const MAX_INSTRUCTIONS = 4000
const MAX_LANGUAGE_INSTRUCTIONS = 2000
const MAX_SUMMARY_INSTRUCTIONS = 2000

export interface LanguageRow {
  language: string
  text: string
}

export interface FormState {
  profile: string
  model: string
  // One model per row, in order; blank rows are not saved and no rows inherits.
  fallbackModels: string[]
  // INHERIT in a repository, otherwise a saved provider connection.
  connection: string
  severityFloor: string
  blockOn: string
  // undefined inherits.
  categories: string[] | undefined
  // "" inherits.
  numbers: Record<NumberName, string>
  // One glob per line; empty inherits. Not split on commas: globs use them in braces.
  ignorePaths: string
  instructions: string
  // output.highLevelSummaryInstructions; "" inherits.
  summaryInstructions: string
  // Rows missing a language or text are not saved.
  languageInstructions: LanguageRow[]
  // undefined inherits the value from the layers below.
  flags: Record<FlagName, boolean | undefined>
  // INHERIT inherits.
  choices: Record<ChoiceName, string>
  // Empty inherits.
  lists: Record<ListName, string[]>
}

export type FormErrors = Partial<
  Record<
    | NumberName
    | ListName
    | "model"
    | "fallbackModels"
    | "connection"
    | "categories"
    | "ignorePaths"
    | "instructions"
    | "summaryInstructions"
    | "languageInstructions",
    string
  >
>

type Section = Record<string, unknown>

function lines(text: string, separators: RegExp) {
  return text
    .split(separators)
    .map((line) => line.trim())
    .filter(Boolean)
}

const modelList = (rows: string[]) => rows.map((model) => model.trim()).filter(Boolean)
const pathList = (text: string) => lines(text, /\n/)
const tagList = (tags: string[]) => tags.map((tag) => tag.trim()).filter(Boolean)

// Settings saved before `triggers.review` existed say the same thing through
// the legacy keys; server/src/review/config/resolve.ts maps them the same way.
function legacyReview(triggers: ConfigOverride["triggers"]): string | undefined {
  if (triggers?.review) return triggers.review
  if (triggers?.onPush === false) return "manual"
  if (triggers?.drafts === true) return "all"
  return undefined
}

function parseNumber(spec: NumberSpec, text: string): number | null | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (spec.nullable && trimmed.toLowerCase() === AUTO) return null
  return Number(trimmed)
}

function languageMap(rows: LanguageRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const language = row.language.trim()
    const text = row.text.trim()
    if (language && text) out[language] = text
  }
  return out
}

export function toForm(settings: ConfigOverride): FormState {
  const flags = {} as FormState["flags"]
  for (const { name, section } of FLAGS) {
    const value = (settings[section] as Section | undefined)?.[name]
    flags[name] = typeof value === "boolean" ? value : undefined
  }
  const numbers = {} as FormState["numbers"]
  for (const { name, section } of NUMBERS) {
    const value = (settings[section] as Section | undefined)?.[name]
    numbers[name] = value === null ? AUTO : typeof value === "number" ? String(value) : ""
  }
  const choices = {} as FormState["choices"]
  for (const { name, section } of CHOICES) {
    const value = name === "review" ? legacyReview(settings.triggers) : (settings[section] as Section | undefined)?.[name]
    choices[name] = typeof value === "string" ? value : INHERIT
  }
  const lists = {} as FormState["lists"]
  for (const name of LISTS) lists[name] = [...(settings.triggers?.[name] ?? [])]
  return {
    profile: settings.profile ?? INHERIT,
    model: settings.llm?.model ?? "",
    fallbackModels: [...(settings.llm?.fallbackModels ?? [])],
    // endpointKey is the provider reference used by the legacy two-field UI.
    // Reading it here converts that configuration on the next save.
    connection: settings.llm?.connection ?? settings.llm?.endpointKey ?? INHERIT,
    severityFloor: settings.review?.severityFloor ?? INHERIT,
    blockOn: settings.review?.blockOn ?? INHERIT,
    categories: settings.review?.categories,
    numbers,
    choices,
    lists,
    ignorePaths: (settings.ignorePaths ?? []).join("\n"),
    instructions: settings.instructions ?? "",
    summaryInstructions: settings.output?.highLevelSummaryInstructions ?? "",
    languageInstructions: Object.entries(settings.languageInstructions ?? {}).map(([language, text]) => ({
      language,
      text,
    })),
    flags,
  }
}

function setOrDelete(section: Section, key: string, value: unknown) {
  if (value === undefined) delete section[key]
  else section[key] = value
}

// Starts from what is saved so keys this form does not show (set through the
// API or a later version) survive a save; "inherit" removes a key.
export function toSettings(base: ConfigOverride, form: FormState): ConfigOverride {
  const next: ConfigOverride = structuredClone(base)
  const pick = (value: string) => (value === INHERIT ? undefined : value)

  setOrDelete(next, "profile", pick(form.profile))
  setOrDelete(next, "instructions", form.instructions.trim() || undefined)
  const ignorePaths = pathList(form.ignorePaths)
  setOrDelete(next, "ignorePaths", ignorePaths.length ? ignorePaths : undefined)
  const languages = languageMap(form.languageInstructions)
  setOrDelete(next, "languageInstructions", Object.keys(languages).length ? languages : undefined)

  const fallbackModels = modelList(form.fallbackModels)
  const fields: Record<string, [string, unknown][]> = {
    llm: [
      ["model", form.model.trim() || undefined],
      ["fallbackModels", fallbackModels.length ? fallbackModels : undefined],
      ["connection", pick(form.connection)],
      // New dashboard writes replace the old copied endpoint values.
      ["baseUrl", undefined],
      ["endpointKey", undefined],
    ],
    review: [
      ["severityFloor", pick(form.severityFloor)],
      ["blockOn", pick(form.blockOn)],
      ["categories", form.categories],
    ],
    output: [["highLevelSummaryInstructions", form.summaryInstructions.trim() || undefined]],
    triggers: [
      // Replaced by `review`, which the form reads them into.
      ["onPush", undefined],
      ["drafts", undefined],
    ],
  }
  for (const { name, section } of FLAGS) fields[section].push([name, form.flags[name]])
  for (const { name, section } of CHOICES) fields[section].push([name, pick(form.choices[name])])
  for (const name of LISTS) {
    const entries = tagList(form.lists[name])
    fields.triggers.push([name, entries.length ? entries : undefined])
  }
  for (const spec of NUMBERS) fields[spec.section].push([spec.name, parseNumber(spec, form.numbers[spec.name])])

  for (const [name, entries] of Object.entries(fields)) {
    const section: Section = { ...((next[name] as Section | undefined) ?? {}) }
    for (const [key, value] of entries) setOrDelete(section, key, value)
    setOrDelete(next, name, Object.keys(section).length ? section : undefined)
  }
  return next
}

// Mirrors the server's bounds; a save is held back while anything is listed.
export function validateForm(form: FormState, connectionRequired = false, savedConnections?: string[]): FormErrors {
  const errors: FormErrors = {}
  for (const spec of NUMBERS) {
    const value = parseNumber(spec, form.numbers[spec.name])
    if (value === undefined || value === null) continue
    const range = spec.max === undefined ? `at least ${spec.min}` : `between ${spec.min} and ${spec.max}`
    if (!Number.isFinite(value) || (spec.integer && !Number.isInteger(value))) {
      errors[spec.name] = spec.nullable
        ? `Enter a whole number or "${AUTO}"`
        : spec.integer
          ? "Enter a whole number"
          : "Enter a number"
    } else if (value < spec.min || (spec.max !== undefined && value > spec.max)) {
      errors[spec.name] = `Must be ${range}`
    }
  }

  const modelHint = 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5'
  if (form.model.trim() && !MODEL_PATTERN.test(form.model.trim())) errors.model = modelHint
  const fallbackModels = modelList(form.fallbackModels)
  if (fallbackModels.length > MAX_FALLBACK_MODELS) errors.fallbackModels = `At most ${MAX_FALLBACK_MODELS} fallback models`
  else if (fallbackModels.some((model) => !MODEL_PATTERN.test(model))) errors.fallbackModels = modelHint

  if (connectionRequired && form.connection === INHERIT) errors.connection = "Select an LLM connection"
  else if (
    form.connection !== INHERIT &&
    savedConnections &&
    !savedConnections.includes(form.connection)
  ) {
    errors.connection = "Select a connection configured in Settings > API keys"
  }

  for (const name of LISTS) {
    const entries = tagList(form.lists[name])
    if (entries.length > MAX_LIST_ENTRIES) errors[name] = `At most ${MAX_LIST_ENTRIES} entries`
    else if (entries.some((entry) => entry.length > MAX_LIST_ENTRY)) errors[name] = `At most ${MAX_LIST_ENTRY} characters per entry`
  }

  if (form.categories?.length === 0) errors.categories = "Choose at least one category"
  if (pathList(form.ignorePaths).length > MAX_IGNORE_PATHS) errors.ignorePaths = `At most ${MAX_IGNORE_PATHS} paths`
  if (form.instructions.trim().length > MAX_INSTRUCTIONS) errors.instructions = `At most ${MAX_INSTRUCTIONS} characters`
  if (form.summaryInstructions.trim().length > MAX_SUMMARY_INSTRUCTIONS)
    errors.summaryInstructions = `At most ${MAX_SUMMARY_INSTRUCTIONS} characters`

  const languages = form.languageInstructions.map((row) => row.language.trim().toLowerCase()).filter(Boolean)
  if (new Set(languages).size !== languages.length) errors.languageInstructions = "Each language can only be listed once"
  else if (form.languageInstructions.some((row) => row.text.trim().length > MAX_LANGUAGE_INSTRUCTIONS))
    errors.languageInstructions = `At most ${MAX_LANGUAGE_INSTRUCTIONS} characters per language`
  return errors
}

// The layers below the global config: the defaults with a profile's preset on
// top, as server/src/review/config/resolve.ts merges them.
export function baseConfig(schema: ConfigSchema, profile: string = schema.defaults.profile): EffectiveConfig {
  const { defaults } = schema
  const preset = schema.profiles[profile] ?? {}
  return {
    ...defaults,
    profile,
    llm: { ...defaults.llm, ...preset.llm },
    review: { ...defaults.review, ...preset.review },
    output: { ...defaults.output, ...preset.output },
    triggers: { ...defaults.triggers, ...preset.triggers },
  }
}

// The global config shows real values instead of "inherit", so picking what
// the profile or defaults already give must not pin it: drop those values and
// the global config keeps following a later profile or default change.
export function withoutDefaults(settings: ConfigOverride, schema: ConfigSchema): ConfigOverride {
  const next: ConfigOverride = structuredClone(settings)
  const base = baseConfig(schema, settings.profile)
  // Arrays and maps are compared by value; key order is stable because the
  // form builds them in a fixed order.
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (next.profile === schema.defaults.profile) delete next.profile
  for (const name of ["ignorePaths", "languageInstructions"] as const) {
    if (name in next && same(next[name], base[name])) delete next[name]
  }
  for (const name of ["llm", "review", "output", "triggers"] as const) {
    const section = next[name] as Section | undefined
    if (!section) continue
    for (const [key, value] of Object.entries(section)) {
      if (same((base[name] as Section)[key], value)) delete section[key]
    }
    if (Object.keys(section).length === 0) delete next[name]
  }
  return next
}

// Compares what would be saved, so whitespace-only edits and toggling a flag
// back to its saved value do not count as changes. `finish` applies the same
// post-processing as the save (e.g. withoutDefaults) to both sides.
export function isDirty(
  base: ConfigOverride,
  form: FormState,
  finish: (settings: ConfigOverride) => ConfigOverride = (settings) => settings,
) {
  const saved = finish(toSettings(base, toForm(base)))
  return JSON.stringify(finish(toSettings(base, form))) !== JSON.stringify(saved)
}
