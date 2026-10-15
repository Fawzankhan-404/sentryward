import type { ReactNode } from "react"
import { Link } from "react-router"
import { Plus, RotateCcw, Trash2 } from "lucide-react"
import { SearchableSelect } from "@/components/SearchableSelect"
import { TagInput } from "@/components/TagInput"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useApiKeys, useLlmModels } from "@/features/llm-connections/api"
import { LLM_PROVIDERS } from "@/features/llm-connections/providers"
import { useConfigSchema, type ConfigOverride, type EffectiveConfig, type LlmProviderName } from "./api"
import { ModelCombobox, type ModelSuggestions } from "./ModelCombobox"
import { ReviewPreview } from "./ReviewPreview"
import { CONFIG_TABS, TAB_ERRORS, type ConfigTab } from "./tabs"
import {
  AUTO,
  CHOICES,
  FLAGS,
  INHERIT,
  MAX_FALLBACK_MODELS,
  NUMBERS,
  toSettings,
  type ChoiceName,
  type FlagName,
  type ListName,
  type FormErrors,
  type FormState,
  type NumberName,
} from "./settingsForm"

const SOURCE_LABEL: Record<string, string> = {
  default: "default",
  profile: "profile",
  global: "global config",
  repoSettings: "these settings",
  repoFile: "repository file",
  trigger: "trigger",
}

const FLAG_INFO: Record<FlagName, { label: string; description: ReactNode }> = {
  requireEvidence: {
    label: "Require evidence",
    description: "Critical and major findings without evidence are demoted instead of blocking.",
  },
  fullFile: { label: "Comment on untouched lines", description: "Allow findings outside the lines the change touched." },
  committableSuggestions: {
    label: "Committable suggestions",
    description: "Offer fixes as suggestions that can be applied from the forge.",
  },
  fileContext: {
    label: "Surrounding code",
    description:
      "Show the reviewer the enclosing function, imports, called definitions and callers of the changed code, read from the head revision.",
  },
  disableCache: {
    label: "Disable cache",
    description: "Disable caching of code and dependencies; fetch them fresh on each run.",
  },
  walkthrough: {
    label: "Walkthrough",
    description:
      "Summarise what the change does at the top of the review comment. When automatic reviews include it is set on the Triggers tab.",
  },
  postInline: { label: "Post inline comments", description: "Comment on the lines each finding refers to." },
  postSummary: { label: "Post summary comment", description: "Post the review summary as a comment on the change." },
  postCheck: { label: "Post commit status", description: "Report the verdict as the sentryward/review status." },
  reviewStats: {
    label: "Show review details",
    description: "Add a line under the summary with the commit, models and how much was reviewed.",
  },
  agentPrompts: {
    label: "Prompt for AI agents per comment",
    description: "Add a ready-to-paste prompt for a coding agent to each actionable inline comment.",
  },
  agentPromptAll: {
    label: "Prompt for all review comments",
    description: "Add one prompt covering every finding to the summary comment, to hand the whole review to a coding agent.",
  },
  blastRadiusLabel: {
    label: "Publish blast radius label",
    description:
      'Add a native PR/MR label with the estimated blast radius (e.g. "Large blast radius"). Needs the walkthrough. Supported on GitHub and GitLab.',
  },
  effortLabel: {
    label: "Publish review time estimate label",
    description:
      'Add a native PR/MR label with the estimated review effort (e.g. "10-20 Minutes"). Needs the walkthrough. Supported on GitHub and GitLab.',
  },
  sequenceDiagrams: {
    label: "Sequence diagrams",
    description: "Include sequence diagrams in the walkthrough, drawn with Mermaid.",
  },
  estimateEffort: {
    label: "Estimate code review effort",
    description: "Include an estimated code review effort in the walkthrough.",
  },
  assessLinkedIssues: {
    label: "Assess linked issues",
    description: "Include an assessment of how well the changes address linked issues in the walkthrough.",
  },
  relatedIssues: {
    label: "Related issues",
    description: "Include potentially related issues in the walkthrough.",
  },
  highLevelSummary: {
    label: "High-level summary",
    description: "Generate a high-level summary of the changes in the PR/MR description or walkthrough.",
  },
  reviewOnPush: {
    label: "Review automatically on push",
    description: "Review the new commits on every push to the PR/MR.",
  },
  command: {
    label: "Allow review command",
    description: (
      <>
        Commenting <code>/sentryward review</code> requests a review.
      </>
    ),
  },
  abortOnClose: {
    label: "Abort on close",
    description: "Abort the in-progress review if the PR is closed or merged.",
  },
}

function connectionLabel(provider: LlmProviderName | null) {
  return provider ? LLM_PROVIDERS[provider].label : "not configured"
}

function configuredConnectionLabel(llm: EffectiveConfig["llm"]) {
  if (llm.connection) return connectionLabel(llm.connection)
  if (llm.baseUrl) return llm.endpointKey ? `${connectionLabel(llm.endpointKey)} (legacy)` : "custom endpoint (legacy)"
  return "not configured"
}

const CHOICE_INFO: Record<ChoiceName, { label: string; description: string; options: { value: string; label: string }[] }> = {
  review: {
    label: "Code review trigger",
    description: "Which pull and merge requests are reviewed automatically when opened or marked ready.",
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
      { value: "all", label: "Draft and published PRs" },
    ],
  },
  summary: {
    label: "PR summary trigger",
    description: "When automatic reviews include the PR summary. Requested reviews always do while the walkthrough is on.",
    options: [
      { value: "manual", label: "Manual only" },
      { value: "published", label: "Published PRs" },
    ],
  },
  highLevelSummaryPlacement: {
    label: "Summary placement",
    description: "Where the high-level summary is written.",
    options: [
      { value: "description", label: "PR/MR description" },
      { value: "walkthrough", label: "Walkthrough" },
    ],
  },
}

const SUMMARY_INSTRUCTIONS_EXAMPLE =
  "Create concise release notes as a bullet-point list, followed by a Markdown table showing lines added and removed by each contributing author."

const LIST_INFO: Record<ListName, { label: string; description: string; placeholder: string }> = {
  ignoreTitles: {
    label: "Ignore by title",
    description: "Titles containing any of these phrases, ignoring case.",
    placeholder: "WIP",
  },
  skipAuthors: {
    label: "Skip by author",
    description: "Logins of whoever opened or pushed the PR/MR.",
    placeholder: "dependabot[bot]",
  },
  skipLabels: {
    label: "Skip by label",
    description: "Labels on the PR/MR, matched exactly and case-sensitively.",
    placeholder: "no-review",
  },
  skipSourceBranches: {
    label: "Skip by source branch",
    description: "Opened from a branch whose name contains any of these.",
    placeholder: "release/",
  },
  skipTargetBranches: {
    label: "Skip by target branch",
    description: "Targeting a branch whose name contains any of these.",
    placeholder: "legacy",
  },
}

// A titled group of fields within a tab.
function Section(props: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    // The legend stays a direct child so it names the fieldset.
    <FieldSet>
      <FieldLegend>{props.title}</FieldLegend>
      <FieldDescription className="-mt-3">{props.description}</FieldDescription>
      {props.children}
    </FieldSet>
  )
}

// Switches as rows of one bordered list, so a run of them reads as a group.
function ToggleList(props: { children: ReactNode }) {
  return <div className="divide-y rounded-lg border *:px-4 *:py-3">{props.children}</div>
}

const NUMBER_INFO: Record<NumberName, { label: string; description: string }> = {
  temperature: { label: "Temperature", description: "Lower is more deterministic." },
  maxTokens: { label: "Max output tokens", description: "Per model call." },
  contextBudget: {
    label: "Context budget",
    description: `Prompt token ceiling per chunk; "${AUTO}" derives it from the model's context window.`,
  },
  maxFindings: { label: "Max findings", description: "The most findings a review reports." },
  maxChunks: { label: "Max chunks", description: "Large changes are split into at most this many passes." },
  minConfidence: { label: "Min confidence", description: "Findings the model is less sure of are dropped (0 to 1)." },
}

// "x (from y)" for any config value, e.g. "critical (from global config)".
function describe(value: unknown, source: string | undefined) {
  let shown: string
  if (typeof value === "boolean") shown = value ? "on" : "off"
  else if (value === null) shown = AUTO
  else if (Array.isArray(value)) shown = value.length ? value.join(", ") : "none"
  else if (typeof value === "object" && value !== undefined) shown = Object.keys(value).join(", ") || "none"
  else shown = String(value)
  return `${shown}${source ? ` (from ${SOURCE_LABEL[source] ?? source})` : ""}`
}

function ResetButton(props: { label: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Reset ${props.label} to inherited`}
          onClick={props.onClick}
          disabled={props.disabled}
        >
          <RotateCcw />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{props.hint ? `Inherit: ${props.hint}` : "Inherit"}</TooltipContent>
    </Tooltip>
  )
}

// A text field where empty means "not set here"; `emptyHint` says what that gives.
function TextField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  description: ReactNode
  emptyHint: string
  placeholder?: string
  multiline?: boolean
  inputMode?: "numeric" | "decimal"
  type?: string
  min?: number
  max?: number
  step?: number
  effective?: string
  error?: string
  disabled?: boolean
}) {
  const shared = {
    id: props.id,
    value: props.value,
    placeholder: props.placeholder,
    disabled: props.disabled,
    "aria-invalid": props.error ? true : undefined,
  }
  return (
    <Field data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      {props.multiline ? (
        <Textarea {...shared} rows={4} onChange={(e) => props.onChange(e.target.value)} />
      ) : (
        <Input
          {...shared}
          type={props.type}
          inputMode={props.inputMode}
          min={props.min}
          max={props.max}
          step={props.step}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      <FieldDescription>
        {props.description} {props.emptyHint}
      </FieldDescription>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </Field>
  )
}

function CategoriesField(props: {
  options: string[]
  value: string[] | undefined
  inherited: string[] | undefined
  onChange: (value: string[] | undefined) => void
  resettable: boolean
  inheritedHint?: string
  effective?: string
  error?: string
  disabled?: boolean
}) {
  const overridden = props.resettable && props.value !== undefined
  const checked = props.value ?? props.inherited
  // Like a toggle, there is nothing truthful to show before the inherited value loads.
  const disabled = props.disabled || checked === undefined

  function toggle(category: string, on: boolean) {
    const current = new Set(checked)
    if (on) current.add(category)
    else current.delete(category)
    // Kept in the schema's order so an unchanged selection compares equal.
    props.onChange(props.options.filter((option) => current.has(option)))
  }

  return (
    <FieldSet data-disabled={disabled} data-invalid={props.error ? true : undefined}>
      <div className="flex items-center gap-2">
        <FieldLegend variant="label">Categories</FieldLegend>
        {overridden && <Badge variant="secondary">Overridden</Badge>}
        {overridden && (
          <ResetButton
            label="Categories"
            hint={props.inheritedHint}
            onClick={() => props.onChange(undefined)}
            disabled={props.disabled}
          />
        )}
      </div>
      <FieldDescription>What kinds of issues the reviewer looks for.</FieldDescription>
      <div className="grid grid-cols-2 gap-2 @md/field-group:grid-cols-3">
        {props.options.map((category) => {
          const id = `category-${category}`
          // A label wrapping a field renders as a selectable card (see FieldLabel).
          return (
            <FieldLabel key={category} htmlFor={id}>
              <Field orientation="horizontal" data-disabled={disabled}>
                <Checkbox
                  id={id}
                  checked={checked?.includes(category) ?? false}
                  onCheckedChange={(on) => toggle(category, on === true)}
                  disabled={disabled}
                />
                <FieldContent>
                  <FieldTitle className="capitalize">{category}</FieldTitle>
                </FieldContent>
              </Field>
            </FieldLabel>
          )
        })}
      </div>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

function LanguageInstructionsField(props: {
  rows: FormState["languageInstructions"]
  onChange: (rows: FormState["languageInstructions"]) => void
  isRepo: boolean
  effective?: string
  error?: string
  disabled?: boolean
}) {
  const { rows } = props
  const update = (index: number, change: Partial<FormState["languageInstructions"][number]>) =>
    props.onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)))

  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Language guidance</FieldLegend>
      <FieldDescription>
        Extra guidance for files in one language.
        {props.isRepo && " Added to the inherited languages; a language listed here replaces its inherited guidance."}
      </FieldDescription>
      {rows.map((row, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-lg border p-3">
          <div className="flex items-center gap-2">
            <Input
              aria-label={`Language ${index + 1}`}
              value={row.language}
              onChange={(e) => update(index, { language: e.target.value })}
              placeholder="TypeScript"
              disabled={props.disabled}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove language ${index + 1}`}
              onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
              disabled={props.disabled}
            >
              <Trash2 />
            </Button>
          </div>
          <Textarea
            aria-label={`Guidance for language ${index + 1}`}
            value={row.text}
            onChange={(e) => update(index, { text: e.target.value })}
            placeholder="Prefer type narrowing over casts."
            rows={2}
            disabled={props.disabled}
          />
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, { language: "", text: "" }])}
          disabled={props.disabled}
        >
          <Plus />
          Add language
        </Button>
      </div>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

function FallbackModelsField(props: {
  rows: string[]
  onChange: (rows: string[]) => void
  emptyHint: string
  effective?: string
  error?: string
  disabled?: boolean
  suggestions?: ModelSuggestions
  warning?: ReactNode
}) {
  const { rows } = props
  return (
    <FieldSet data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLegend variant="label">Fallback models</FieldLegend>
      {rows.map((model, index) => (
        <div key={index} className="flex items-center gap-2">
          <ModelCombobox
            aria-label={`Fallback model ${index + 1}`}
            value={model}
            onChange={(value) => props.onChange(rows.map((row, i) => (i === index ? value : row)))}
            placeholder="openai/gpt-5"
            disabled={props.disabled}
            aria-invalid={props.error ? true : undefined}
            suggestions={props.suggestions}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove fallback model ${index + 1}`}
            onClick={() => props.onChange(rows.filter((_, i) => i !== index))}
            disabled={props.disabled}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => props.onChange([...rows, ""])}
          disabled={props.disabled || rows.length >= MAX_FALLBACK_MODELS}
        >
          <Plus />
          Add fallback model
        </Button>
      </div>
      <FieldDescription>
        Tried in order when the model fails, up to {MAX_FALLBACK_MODELS}. {props.emptyHint}
      </FieldDescription>
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.warning}
      {props.error && <FieldError>{props.error}</FieldError>}
    </FieldSet>
  )
}

function ChoiceField(props: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  // Present in a repository, where the field can fall back to the global config;
  // the description says what that currently resolves to.
  inherit?: { description?: string }
  // Shown instead of "inherit" when there is no Inherit option.
  fallback?: string
  description?: ReactNode
  effective?: string
  error?: string
  disabled?: boolean
}) {
  const { inherit } = props
  const value = !inherit && props.value === INHERIT ? (props.fallback ?? INHERIT) : props.value
  return (
    <Field data-disabled={props.disabled} data-invalid={props.error ? true : undefined}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      <SearchableSelect
        id={props.id}
        value={value}
        onValueChange={props.onChange}
        disabled={props.disabled}
        aria-invalid={props.error ? true : undefined}
        options={
          inherit ? [{ value: INHERIT, label: "Inherit", description: inherit.description }, ...props.options] : props.options
        }
      />
      {props.description && <FieldDescription>{props.description}</FieldDescription>}
      {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      {props.error && <FieldError>{props.error}</FieldError>}
    </Field>
  )
}

// A switch over a tri-state value: it shows the override when there is one and
// the inherited value otherwise, so "inherit" stays reachable through reset.
function ToggleField(props: {
  name: FlagName
  value: boolean | undefined
  inherited: boolean | undefined
  onChange: (value: boolean | undefined) => void
  // Only a repository can go back to inheriting; the global config just holds a value.
  resettable: boolean
  inheritedHint?: string
  effective?: string
  disabled?: boolean
}) {
  const { label, description } = FLAG_INFO[props.name]
  const id = `flag-${props.name}`
  const overridden = props.resettable && props.value !== undefined
  // Without an override or a resolved value there is nothing truthful to show yet.
  const disabled = props.disabled || (!overridden && props.inherited === undefined)

  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <FieldContent>
        <div className="flex items-center gap-2">
          <FieldLabel htmlFor={id}>{label}</FieldLabel>
          {overridden && <Badge variant="secondary">Overridden</Badge>}
        </div>
        <FieldDescription>{description}</FieldDescription>
        {props.effective && <FieldDescription className="text-xs">{props.effective}</FieldDescription>}
      </FieldContent>
      <div className="flex items-center gap-2">
        {overridden && (
          <ResetButton
            label={label}
            hint={props.inheritedHint}
            onClick={() => props.onChange(undefined)}
            disabled={props.disabled}
          />
        )}
        <Switch
          id={id}
          checked={props.value ?? props.inherited ?? false}
          onCheckedChange={(checked) => props.onChange(checked)}
          disabled={disabled}
        />
      </div>
    </Field>
  )
}

// The editable subset of a review config, shared by the global config and a
// repository's overrides, split into tabs. `config`/`sources` describe the
// effective values; `inherited`/`inheritedSources` describe what a field gets
// when this scope does not set it (the profile and defaults for the global
// config, the global config for a repository). Form state lives in the caller,
// so switching tabs keeps unsaved edits and one save covers every tab.
export function ConfigFields(props: {
  mode: "global" | "repo"
  form: FormState
  onChange: (form: FormState) => void
  tab: ConfigTab
  onTabChange: (tab: ConfigTab) => void
  // Shown between the tab list and the open tab, e.g. warnings for the scope.
  notices?: ReactNode
  // The save bar, at the bottom of every tab.
  footer: ReactNode
  config?: EffectiveConfig
  sources?: Record<string, string>
  inherited?: EffectiveConfig
  inheritedSources?: Record<string, string>
  errors?: FormErrors
  disabled?: boolean
  guidanceLabel?: string
}) {
  const { mode, form, config, sources, inherited, disabled } = props
  const errors = props.errors ?? {}
  const isRepo = mode === "repo"
  const schema = useConfigSchema()
  const apiKeys = useApiKeys()
  // The model pickers list what the connection that will run the review
  // offers: the inherited one while this scope does not pick its own.
  const modelsProvider =
    disabled || form.connection === INHERIT
      ? (inherited?.llm.connection ?? null)
      : (form.connection as LlmProviderName)
  const llmModels = useLlmModels(modelsProvider)
  const modelSuggestions: ModelSuggestions | undefined = modelsProvider
    ? { models: llmModels.data?.models ?? [], loading: llmModels.isPending, error: llmModels.isError }
    : undefined
  // An official API only runs its own models (the worker refuses the rest);
  // a custom host may serve any provider's protocol.
  const officialProvider =
    modelsProvider && apiKeys.data?.keys.some((key) => key.provider === modelsProvider && key.stored && !key.baseUrl)
      ? modelsProvider
      : null
  const runsOn = (model: string) => !officialProvider || !model.trim() || model.trim().startsWith(`${officialProvider}/`)
  const mismatchHint = officialProvider && (
    <FieldDescription className="text-destructive">
      The {LLM_PROVIDERS[officialProvider].label} connection can only run {officialProvider}/... models.
    </FieldDescription>
  )
  type TextKey = "profile" | "model" | "severityFloor" | "blockOn" | "ignorePaths" | "instructions"
  const setField = (key: TextKey) => (value: string) => props.onChange({ ...form, [key]: value })
  const setFlag = (name: FlagName) => (value: boolean | undefined) =>
    props.onChange({ ...form, flags: { ...form.flags, [name]: value } })
  const setNumber = (name: NumberName) => (value: string) =>
    props.onChange({ ...form, numbers: { ...form.numbers, [name]: value } })

  function effective(path: string, value: unknown) {
    if (!config) return undefined
    return `Effective: ${describe(value, sources?.[path])}`
  }

  // What "Inherit" resolves to right now, e.g. "critical (from global config)".
  function inheritedHint(path: string, value: unknown) {
    if (!inherited || value === undefined) return undefined
    return describe(value, props.inheritedSources?.[path])
  }

  function choice(path: string, value: string | undefined) {
    return isRepo ? { inherit: { description: inheritedHint(path, value) } } : { fallback: value }
  }

  function inheritedFlag(name: FlagName) {
    const { section } = FLAGS.find((flag) => flag.name === name)!
    return inherited ? (inherited[section] as Record<string, unknown>)[name] as boolean : undefined
  }

  // `off` greys out settings that do nothing right now, e.g. labels without a summary.
  function toggles(names: FlagName[], off = false) {
    return names.map((name) => {
      const { section } = FLAGS.find((flag) => flag.name === name)!
      const path = `${section}.${name}`
      const fallback = inheritedFlag(name)
      return (
        <ToggleField
          key={name}
          name={name}
          value={form.flags[name]}
          inherited={fallback}
          onChange={setFlag(name)}
          resettable={isRepo}
          inheritedHint={inheritedHint(path, fallback)}
          effective={config && effective(path, (config[section] as Record<string, unknown>)[name])}
          disabled={disabled || off}
        />
      )
    })
  }

  // What leaving a text field empty gives in this scope.
  function emptyHint(path: string, value: unknown) {
    if (isRepo) return `Leave empty to inherit${inherited ? ` ${inheritedHint(path, value)}` : ""}.`
    return `Leave empty to use the default${inherited ? ` (${describe(value, undefined)})` : ""}.`
  }

  function choiceField(name: ChoiceName, off = false) {
    const { section } = CHOICES.find((choice) => choice.name === name)!
    const path = `${section}.${name}`
    const fallback = inherited ? ((inherited[section] as Record<string, unknown>)[name] as string) : undefined
    const info = CHOICE_INFO[name]
    const label = (value: unknown) => info.options.find((option) => option.value === value)?.label ?? value
    return (
      <ChoiceField
        id={`choice-${name}`}
        label={info.label}
        value={form.choices[name]}
        onChange={(value) => props.onChange({ ...form, choices: { ...form.choices, [name]: value } })}
        options={info.options}
        // The global config selects the fallback itself, so it stays the raw value.
        {...(isRepo ? { inherit: { description: inheritedHint(path, fallback && label(fallback)) } } : { fallback })}
        description={info.description}
        effective={config && effective(path, label((config[section] as Record<string, unknown>)[name]))}
        disabled={disabled || off}
      />
    )
  }

  function listField(name: ListName) {
    const path = `triggers.${name}`
    const fallback = inherited?.triggers[name]
    const info = LIST_INFO[name]
    const id = `list-${name}`
    const error = errors[name]
    // Only worth a hint when leaving it empty actually inherits something.
    const hint = isRepo && fallback?.length ? ` ${emptyHint(path, fallback)}` : ""
    return (
      <Field data-disabled={disabled} data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>{info.label}</FieldLabel>
        <TagInput
          id={id}
          value={form.lists[name]}
          onChange={(value) => props.onChange({ ...form, lists: { ...form.lists, [name]: value } })}
          placeholder={fallback?.length ? fallback.join(", ") : `e.g. ${info.placeholder}, then Enter`}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
        />
        <FieldDescription>
          {info.description}
          {hint}
        </FieldDescription>
        {config && <FieldDescription className="text-xs">{effective(path, config.triggers[name])}</FieldDescription>}
        {error && <FieldError>{error}</FieldError>}
      </Field>
    )
  }

  function numberField(name: NumberName) {
    const spec = NUMBERS.find((number) => number.name === name)!
    const path = `${spec.section}.${name}`
    const fallback = inherited ? (inherited[spec.section] as Record<string, unknown>)[name] as number | null : undefined
    const { label, description } = NUMBER_INFO[name]
    return (
      <TextField
        id={`number-${name}`}
        label={label}
        value={form.numbers[name]}
        onChange={setNumber(name)}
        description={description}
        emptyHint={emptyHint(path, fallback)}
        placeholder={fallback === undefined ? undefined : fallback === null ? AUTO : String(fallback)}
        // The context budget also takes "auto", which a number input would reject.
        type={spec.nullable ? "text" : "number"}
        inputMode={spec.integer ? "numeric" : "decimal"}
        min={spec.nullable ? undefined : spec.min}
        max={spec.nullable ? undefined : spec.max}
        step={spec.nullable ? undefined : spec.step}
        effective={config && effective(path, (config[spec.section] as Record<string, unknown>)[name])}
        error={errors[name]}
        disabled={disabled}
      />
    )
  }

  // A repository that follows the global config ignores its overrides, so it
  // shows (and previews) the global values.
  const shownFlag = (name: FlagName) => (disabled ? inheritedFlag(name) : (form.flags[name] ?? inheritedFlag(name))) ?? false
  const walkthroughOn = shownFlag("walkthrough")
  const postSummaryOn = shownFlag("postSummary")
  const postInlineOn = shownFlag("postInline")
  const highLevelSummaryOn = walkthroughOn && shownFlag("highLevelSummary")
  const inheritedSummaryInstructions = inherited?.output.highLevelSummaryInstructions

  // The preview follows the form, unsaved edits included: the server layers
  // what the form sets over what it inherits. Values the server would reject
  // hold the preview back (the connection is not part of it).
  const blocking = Object.entries(errors).some(([key, message]) => key !== "connection" && message)
  const previewRequest =
    inherited && !blocking
      ? { base: inherited as ConfigOverride, settings: disabled ? {} : toSettings({}, form) }
      : null

  const storedConnections = (apiKeys.data?.keys ?? []).filter((key) => key.stored)
  const selectedProvider = form.connection === INHERIT ? null : (form.connection as LlmProviderName)
  const selectedIsMissing = selectedProvider && !storedConnections.some((key) => key.provider === selectedProvider)
  const connectionOptions = [
    ...storedConnections.map((key) => ({
      value: key.provider,
      label: LLM_PROVIDERS[key.provider].label,
      description: key.baseUrl ?? (key.last4 ? `key ending in ${key.last4}` : "saved connection"),
      icon: LLM_PROVIDERS[key.provider].icon,
    })),
    ...(selectedIsMissing
      ? [{
          value: selectedProvider,
          label: `${LLM_PROVIDERS[selectedProvider].label} (not configured)`,
          disabled: true,
        }]
      : []),
  ]

  const severities = (schema.data?.severities ?? []).map((s) => ({ value: s, label: s }))
  const profiles = Object.keys(schema.data?.profiles ?? {}).map((p) => ({ value: p, label: p }))

  const panels: Record<ConfigTab, ReactNode> = {
    llm: (
      <>
        <Section title="Connection" description="Which preset applies and which saved connection runs the review.">
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            <ChoiceField
              id="profile"
              label="Profile"
              value={form.profile}
              onChange={setField("profile")}
              options={profiles}
              {...choice("profile", inherited?.profile)}
              description="A preset that fills in values on every tab; anything set here wins over it."
              effective={config && effective("profile", config.profile)}
              disabled={disabled}
            />
            <div className="flex flex-col gap-2">
              <ChoiceField
                id="llm-connection"
                label="LLM connection"
                value={form.connection}
                onChange={(connection) => props.onChange({ ...form, connection })}
                options={connectionOptions}
                inherit={
                  isRepo
                    ? { description: inherited && inheritedHint("llm.connection", configuredConnectionLabel(inherited.llm)) }
                    : undefined
                }
                description={
                  <>
                    Uses the latest key and API host configured in{" "}
                    <Link className="underline underline-offset-4" to="/llm-connections">LLM Connections</Link>.
                  </>
                }
                effective={config && effective("llm.connection", configuredConnectionLabel(config.llm))}
                error={errors.connection}
                disabled={disabled || apiKeys.isPending}
              />
              {apiKeys.isSuccess && storedConnections.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No saved connections. Add one in{" "}
                  <Link className="underline underline-offset-4" to="/llm-connections">
                    LLM Connections
                  </Link>
                  .
                </p>
              )}
              {apiKeys.isError && <p className="text-sm text-destructive">Could not load LLM connections.</p>}
            </div>
          </div>
        </Section>
        <FieldSeparator />
        <Section title="Models" description="The model that reviews the change, and the ones tried when it fails.">
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            <Field data-disabled={disabled}>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              <ModelCombobox
                id="model"
                value={form.model}
                onChange={setField("model")}
                placeholder={inherited?.llm.model ?? config?.llm.model ?? "anthropic/claude-sonnet-5-5"}
                disabled={disabled}
                aria-invalid={errors.model ? true : undefined}
                suggestions={modelSuggestions}
              />
              <FieldDescription>
                provider/model;{" "}
                {isRepo
                  ? `leave empty to inherit${inherited ? ` ${inheritedHint("llm.model", inherited.llm.model)}` : ""}.`
                  : `leave empty to use the default${inherited ? ` (${inherited.llm.model})` : ""}.`}
              </FieldDescription>
              {config && <FieldDescription className="text-xs">{effective("llm.model", config.llm.model)}</FieldDescription>}
              {!disabled && !runsOn(form.model) && mismatchHint}
              {errors.model && <FieldError>{errors.model}</FieldError>}
            </Field>
            <FallbackModelsField
              rows={form.fallbackModels}
              onChange={(fallbackModels) => props.onChange({ ...form, fallbackModels })}
              emptyHint={emptyHint("llm.fallbackModels", inherited?.llm.fallbackModels)}
              effective={config && effective("llm.fallbackModels", config.llm.fallbackModels)}
              error={errors.fallbackModels}
              disabled={disabled}
              suggestions={modelSuggestions}
              warning={!disabled && !form.fallbackModels.every(runsOn) ? mismatchHint : undefined}
            />
          </div>
        </Section>
        <FieldSeparator />
        <Section title="Model calls" description="How each request to the model is made.">
          <div className="grid gap-4 @md/field-group:grid-cols-3">
            {numberField("temperature")}
            {numberField("maxTokens")}
            {numberField("contextBudget")}
          </div>
        </Section>
      </>
    ),
    findings: (
      <>
        <Section title="Severity" description="What is reported, and what fails the review and its commit status.">
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            <ChoiceField
              id="severity-floor"
              label="Report findings at or above"
              value={form.severityFloor}
              onChange={setField("severityFloor")}
              options={severities}
              {...choice("review.severityFloor", inherited?.review.severityFloor)}
              effective={config && effective("review.severityFloor", config.review.severityFloor)}
              disabled={disabled}
            />
            <ChoiceField
              id="block-on"
              label="Block at or above"
              value={form.blockOn}
              onChange={setField("blockOn")}
              options={severities}
              {...choice("review.blockOn", inherited?.review.blockOn)}
              effective={config && effective("review.blockOn", config.review.blockOn)}
              disabled={disabled}
            />
          </div>
        </Section>
        <FieldSeparator />
        <Section
          title="What gets reported"
          description="The kinds of issues the reviewer looks for, and how many it reports."
        >
          <CategoriesField
            options={schema.data?.categories ?? []}
            value={form.categories}
            inherited={inherited?.review.categories}
            onChange={(categories) => props.onChange({ ...form, categories })}
            resettable={isRepo}
            inheritedHint={inheritedHint("review.categories", inherited?.review.categories)}
            effective={config && effective("review.categories", config.review.categories)}
            error={errors.categories}
            disabled={disabled}
          />
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {numberField("maxFindings")}
            {numberField("minConfidence")}
          </div>
        </Section>
        <FieldSeparator />
        <Section title="Review rules" description="How findings are checked and how fixes are offered.">
          <ToggleList>{toggles(["requireEvidence", "fullFile", "fileContext", "committableSuggestions"])}</ToggleList>
        </Section>
      </>
    ),
    files: (
      <>
        <TextField
          id="ignore-paths"
          label="Ignore paths"
          value={form.ignorePaths}
          onChange={setField("ignorePaths")}
          description="Glob patterns for files that are never reviewed, one per line. A list here replaces the inherited one."
          emptyHint={emptyHint("ignorePaths", inherited?.ignorePaths)}
          placeholder={inherited?.ignorePaths.join("\n") || "**/generated/**"}
          multiline
          effective={config && effective("ignorePaths", config.ignorePaths)}
          error={errors.ignorePaths}
          disabled={disabled}
        />
        {numberField("maxChunks")}
        <ToggleList>{toggles(["disableCache"])}</ToggleList>
      </>
    ),
    display: (
      <>
        <Section title="Review comments" description="What the review leaves on the change.">
          <ToggleList>{toggles(["postInline", "postSummary", "postCheck"])}</ToggleList>
          {/* The details line is part of the summary comment. */}
          <ToggleList>{toggles(["reviewStats"], !postSummaryOn)}</ToggleList>
          {/* Each prompt lives in the comment it belongs to. */}
          <ToggleList>{toggles(["agentPrompts"], !postInlineOn)}</ToggleList>
          <ToggleList>{toggles(["agentPromptAll"], !postSummaryOn)}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="PR summary" description="A summary of what the change does, and labels from its estimates.">
          <ToggleList>{toggles(["walkthrough"])}</ToggleList>
          {/* Labels come from the summary's estimates, so they need one. */}
          <ToggleList>{toggles(["blastRadiusLabel", "effortLabel"], !walkthroughOn)}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Walkthrough content"
          description="Optional parts of the PR summary. Each one asks the model for more."
        >
          <ToggleList>
            {toggles(["estimateEffort", "sequenceDiagrams", "assessLinkedIssues", "relatedIssues"], !walkthroughOn)}
          </ToggleList>
        </Section>
        <FieldSeparator />
        <Section title="High-level summary" description="Release notes for the change, or whatever the instructions ask for.">
          <ToggleList>{toggles(["highLevelSummary"], !walkthroughOn)}</ToggleList>
          {choiceField("highLevelSummaryPlacement", !highLevelSummaryOn)}
          <TextField
            id="summary-instructions"
            label="High level summary instructions"
            value={form.summaryInstructions}
            onChange={(summaryInstructions) => props.onChange({ ...form, summaryInstructions })}
            description="By default, Sentryward generates release notes in the description. Use this to customize the summary content and format."
            emptyHint={
              isRepo && inheritedSummaryInstructions
                ? emptyHint("output.highLevelSummaryInstructions", inheritedSummaryInstructions)
                : "Leave empty for release notes."
            }
            placeholder={inheritedSummaryInstructions || SUMMARY_INSTRUCTIONS_EXAMPLE}
            multiline
            effective={
              config &&
              effective("output.highLevelSummaryInstructions", config.output.highLevelSummaryInstructions || "release notes")
            }
            error={errors.summaryInstructions}
            disabled={disabled || !highLevelSummaryOn}
          />
        </Section>
      </>
    ),
    triggers: (
      <>
        <Section
          title="Code reviews"
          description="When Sentryward reviews a pull or merge request, and writes its summary, on its own."
        >
          <div className="grid gap-4 @md/field-group:grid-cols-2">
            {choiceField("review")}
            {choiceField("summary")}
          </div>
          <ToggleList>{toggles(["reviewOnPush", "command", "abortOnClose"])}</ToggleList>
        </Section>
        <FieldSeparator />
        <Section
          title="Skip rules"
          description="Automatic reviews skip a PR/MR that matches any rule. Manual reviews and /sentryward review always run."
        >
          <div className="grid gap-x-4 gap-y-5 @md/field-group:grid-cols-2">
            {listField("ignoreTitles")}
            {listField("skipAuthors")}
            {listField("skipSourceBranches")}
            {listField("skipTargetBranches")}
            {listField("skipLabels")}
          </div>
        </Section>
      </>
    ),
    guidance: (
      <>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor="instructions">{props.guidanceLabel ?? "Guidance"}</FieldLabel>
          <Textarea
            id="instructions"
            value={form.instructions}
            onChange={(e) => setField("instructions")(e.target.value)}
            placeholder="Controllers stay thin; business logic lives in services."
            rows={4}
            disabled={disabled}
            aria-invalid={errors.instructions ? true : undefined}
          />
          <FieldDescription>Project conventions passed to the reviewer with every change.</FieldDescription>
          {errors.instructions && <FieldError>{errors.instructions}</FieldError>}
        </Field>
        <LanguageInstructionsField
          rows={form.languageInstructions}
          onChange={(languageInstructions) => props.onChange({ ...form, languageInstructions })}
          isRepo={isRepo}
          effective={config && effective("languageInstructions", config.languageInstructions)}
          error={errors.languageInstructions}
          disabled={disabled}
        />
      </>
    ),
  }

  return (
    <Tabs value={props.tab} onValueChange={(value) => props.onTabChange(value as ConfigTab)}>
      <TabsList>
        {CONFIG_TABS.map((item) => {
          const invalid = TAB_ERRORS[item.value].some((key) => errors[key])
          return (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
              {invalid && (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
                  <span className="sr-only">, has errors</span>
                </>
              )}
            </TabsTrigger>
          )
        })}
      </TabsList>
      {props.notices}
      {CONFIG_TABS.map((item) => {
        const card = (
          <Card>
            <CardHeader>
              <CardTitle>{item.label}</CardTitle>
              <CardDescription>{item.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <FieldGroup className="gap-6">{panels[item.value]}</FieldGroup>
              {props.footer}
            </CardContent>
          </Card>
        )
        return (
          <TabsContent key={item.value} value={item.value}>
            {item.value === "display" ? (
              <div className="grid items-start gap-4 @3xl:grid-cols-2">
                {card}
                <Card role="region" aria-label="Review preview" className="@3xl:sticky @3xl:top-4">
                  <CardHeader>
                    <CardTitle>Preview</CardTitle>
                    <CardDescription>
                      What Sentryward would post on a sample change with these settings, including unsaved edits.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ReviewPreview request={previewRequest} />
                  </CardContent>
                </Card>
              </div>
            ) : (
              card
            )}
          </TabsContent>
        )
      })}
    </Tabs>
  )
}
