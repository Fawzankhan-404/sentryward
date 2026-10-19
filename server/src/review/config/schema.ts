import { z } from "zod";
import { categorySchema, severitySchema } from "../core/severity.ts";

export const PROFILE_NAMES = ["balanced", "fast", "strict", "security"] as const;
export const profileNameSchema = z.enum(PROFILE_NAMES);
export type ProfileName = z.infer<typeof profileNameSchema>;

// Field shapes are declared once, without defaults: the full schema validates a
// merged config, and the override schema validates one layer of it. Defaults
// live in DEFAULT_CONFIG so a layer never fills in fields it did not set.
// There is deliberately no API key or token here. Endpoints exist only in the
// dashboard layers (see dashboardOverrideSchema): a repository file must never
// be able to point Sentryward's credentials somewhere else.
// The model id may itself contain slashes and parentheses, as router ids such
// as "openai/cx/gpt-5.6-sol(medium)" do; the provider is what precedes the first slash.
const modelString = z
  .string()
  .regex(/^(anthropic|openai|google|ollama)\/[\w.:()/-]+$/, 'Use "provider/model", e.g. anthropic/claude-sonnet-5-5');


const llmShape = {
  model: modelString,
  fallbackModels: z.array(modelString).max(3),
  temperature: z.number().min(0).max(1),
  maxTokens: z.number().int().min(1000).max(64000),
  // Prompt token ceiling; null derives it from the model's context window.
  contextBudget: z.number().int().min(4000).nullable(),
};

// Settable only from the dashboard, never from a repository file or a trigger.
const dashboardLlmShape = {
  ...llmShape,
  // A live reference to one of the owner's saved provider connections. The
  // worker resolves its current key and host when the review runs.
  connection: z.enum(["anthropic", "openai", "google", "ollama"]).nullable(),
  // Legacy endpoint fields remain readable so settings saved by an older
  // release keep working until the dashboard writes the new connection field.
  // One endpoint, such as a 9router proxy, for every model call; null means
  // each provider's official API. The model's provider prefix still picks the
  // wire format.
  baseUrl: z.url({ protocol: /^https?$/, error: "Enter an http or https URL" }).max(500).nullable(),
  // Which stored provider key is sent to baseUrl; null sends each model's own
  // provider key. Names a key slot, never holds the key.
  endpointKey: z.enum(["anthropic", "openai", "google", "ollama"]).nullable(),
};

export const VERIFY_MODES = ["off", "blocking", "all"] as const;

const reviewShape = {
  categories: z.array(categorySchema).min(1),
  // What is reported at all.
  severityFloor: severitySchema,
  // What fails the verdict and the commit status. Not the same as the floor.
  blockOn: severitySchema,
  maxFindings: z.number().int().min(1).max(100),
  maxChunks: z.number().int().min(1).max(50),
  minConfidence: z.number().min(0).max(1),
  // A critical or major model finding without evidence is demoted, not blocking.
  requireEvidence: z.boolean(),
  // Feed back findings this team dismissed as false positives or intentional:
  // an ignored finding is never reposted on the same change, and recent repo
  // ignores are listed in the prompt so the model does not raise them again.
  suppressIgnored: z.boolean(),
  // Allow findings on lines the change did not touch.
  fullFile: z.boolean(),
  committableSuggestions: z.boolean(),
  // Fetch the change and repository file fresh instead of reusing what an
  // earlier run in the same worker already fetched.
  disableCache: z.boolean(),
  // Show each pass the enclosing scope, imports, definitions and callers of
  // the changed code, read from the head revision, next to the diff.
  fileContext: z.boolean(),
  // Re-check findings with a second model call before they count: refuted
  // ones are dropped, uncertain ones demoted like an unproven blocker.
  // "blocking" checks only those at or above blockOn, "all" every finding.
  verify: z.enum(VERIFY_MODES),
  // Report what static analyzers already found on the change (GitHub check
  // run annotations, GitLab Code Quality and SAST reports) as tool findings.
  toolFindings: z.boolean(),
  // Let those tool findings reach blockOn and fail the verdict.
  toolFindingsBlock: z.boolean(),
};

export const SUMMARY_LOCATIONS = ["dynamic", "description", "comment"] as const;
export const REVIEW_TRIGGERS = ["manual", "published", "all"] as const;
export const SUMMARY_TRIGGERS = ["manual", "published"] as const;
export const HIGH_LEVEL_SUMMARY_PLACEMENTS = ["description", "walkthrough"] as const;

const outputShape = {
  walkthrough: z.boolean(),
  postInline: z.boolean(),
  postSummary: z.boolean(),
  postCheck: z.boolean(),
  // Resolve an inline thread once a later run no longer reports its finding,
  // and reopen it if the finding comes back.
  resolveFixedThreads: z.boolean(),
  // The line under the summary naming the commit, models, passes and files
  // reviewed.
  reviewStats: z.boolean(),
  // Ready-to-paste instructions for a coding agent: one per actionable inline
  // comment, and one in the summary covering every finding.
  agentPrompts: z.boolean(),
  agentPromptAll: z.boolean(),
  // Legacy and ignored: the walkthrough always opens the review comment now.
  // Still accepted so older files and saved settings keep validating.
  summaryLocation: z.enum(SUMMARY_LOCATIONS),
  // Native labels from the walkthrough's estimates, e.g. "Large blast radius".
  blastRadiusLabel: z.boolean(),
  effortLabel: z.boolean(),
  // Optional walkthrough parts. Each one asks the model for more, so each can
  // be turned off on its own.
  sequenceDiagrams: z.boolean(),
  estimateEffort: z.boolean(),
  assessLinkedIssues: z.boolean(),
  relatedIssues: z.boolean(),
  // Release notes by default; the instructions replace that guidance.
  highLevelSummary: z.boolean(),
  highLevelSummaryPlacement: z.enum(HIGH_LEVEL_SUMMARY_PLACEMENTS),
  highLevelSummaryInstructions: z.string().max(2000),
};

// Phrases, logins, labels and branch names; matching rules are in filters.ts.
const skipList = z.array(z.string().trim().min(1).max(200)).max(50);

const triggersShape = {
  // Which changes are reviewed automatically when opened or marked ready:
  // none, published only, or drafts too.
  review: z.enum(REVIEW_TRIGGERS),
  // Review again when an open PR/MR receives new commits.
  reviewOnPush: z.boolean(),
  // Review the whole change on push, instead of only the files the new commits
  // touched since the last completed review (worker/incremental.ts).
  fullReviewOnPush: z.boolean(),
  // Legacy, from before `review` existed: onPush turned all automatic reviews
  // on or off and drafts included drafts. Still accepted so older files and
  // saved settings keep validating; resolve.ts maps them onto `review`.
  onPush: z.boolean(),
  drafts: z.boolean(),
  // Whether automatic reviews include the walkthrough. A requested review always may.
  summary: z.enum(SUMMARY_TRIGGERS),
  // Allow "/sentryward review" in a comment to request a review.
  command: z.boolean(),
  // Stop a review in progress once its PR/MR is closed or merged.
  abortOnClose: z.boolean(),
  ignoreTitles: skipList,
  skipAuthors: skipList,
  skipLabels: skipList,
  skipSourceBranches: skipList,
  skipTargetBranches: skipList,
};

const topLevelShape = {
  version: z.literal(1),
  profile: profileNameSchema,
  ignorePaths: z.array(z.string().min(1)).max(200),
  instructions: z.string().max(4000),
  languageInstructions: z.record(z.string().min(1), z.string().max(2000)),
};

export const configSchema = z.strictObject({
  ...topLevelShape,
  llm: z.strictObject(dashboardLlmShape),
  review: z.strictObject(reviewShape),
  output: z.strictObject(outputShape),
  triggers: z.strictObject(triggersShape),
});
export type Config = z.infer<typeof configSchema>;

export const configOverrideSchema = z
  .strictObject({
    ...topLevelShape,
    llm: z.strictObject(llmShape).partial(),
    review: z.strictObject(reviewShape).partial(),
    output: z.strictObject(outputShape).partial(),
    triggers: z.strictObject(triggersShape).partial(),
  })
  .partial();
export type ConfigOverride = z.infer<typeof configOverrideSchema>;

// The global config and repository settings, saved by the repository owner in
// the dashboard. Only these layers may set endpoints; the repository file and
// triggers use configOverrideSchema, which rejects them as unknown settings.
export const dashboardOverrideSchema = configOverrideSchema.extend({
  llm: z.strictObject(dashboardLlmShape).partial().optional(),
});
export type DashboardOverride = z.infer<typeof dashboardOverrideSchema>;

export const DEFAULT_CONFIG: Config = {
  version: 1,
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
    categories: ["security", "bug", "performance", "logic", "reliability"],
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
    summaryLocation: "dynamic",
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
    onPush: true,
    drafts: false,
    summary: "published",
    command: true,
    abortOnClose: true,
    ignoreTitles: [],
    skipAuthors: [],
    skipLabels: [],
    skipSourceBranches: [],
    skipTargetBranches: [],
  },
  ignorePaths: [
    "**/*.lock",
    "**/package-lock.json",
    "**/pnpm-lock.yaml",
    "**/*.min.js",
    "**/*.min.css",
    "**/*.map",
    "**/vendor/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
  ],
  instructions: "",
  languageInstructions: {},
};
