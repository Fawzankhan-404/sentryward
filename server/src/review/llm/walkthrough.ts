import type { Config } from "../config/schema.ts";
import type { ChangedFile, ChangeSet, IssueContext, LlmUsage, Walkthrough } from "../core/models.ts";
import { estimateTokens } from "../context/budget.ts";
import { renderFileDiff } from "../context/diffText.ts";
import {
  DEFAULT_HIGH_LEVEL_SUMMARY_INSTRUCTIONS,
  WALKTHROUGH_SYSTEM_PROMPT,
  walkthroughUserPrompt,
  type WalkthroughExtras,
} from "./prompt.ts";
import { generateWithFallback, modelChain, type Generate } from "./providers.ts";
import { repairWalkthroughOutput, walkthroughSchemaFor, type FullWalkthroughOutput } from "./schemas.ts";

// The overview needs breadth, not every line: files are included whole until
// this budget, then listed by name only.
const WALKTHROUGH_DIFF_TOKENS = 20_000;

function overviewDiff(files: ChangedFile[]): string {
  const blocks: string[] = [];
  const listed: string[] = [];
  let tokens = 0;
  for (const file of files) {
    const text = renderFileDiff(file);
    const fileTokens = estimateTokens(text);
    if (tokens + fileTokens <= WALKTHROUGH_DIFF_TOKENS) {
      blocks.push(text);
      tokens += fileTokens;
    } else {
      listed.push(`- ${file.path} (${file.changeType})`);
    }
  }
  if (listed.length) blocks.push(`Also changed (diff not shown):\n${listed.join("\n")}`);
  return blocks.join("\n\n");
}

// Issues the forge found for the change, fetched by the worker. An empty list
// means none were found; undefined means the setting is off or the lookup failed.
export interface WalkthroughIssues {
  linked?: IssueContext[];
  candidates?: IssueContext[];
}

// A diagram is kept only when it is one; anything else the model wrote there
// would render as a broken block on the forge.
function diagramSource(text: string | undefined): string | undefined {
  const source = (text ?? "")
    .trim()
    .replace(/^```(?:mermaid)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  return /^sequenceDiagram\b/.test(source) ? source.replaceAll("```", "") : undefined;
}

export async function generateWalkthrough(
  generate: Generate,
  changeSet: ChangeSet,
  files: ChangedFile[],
  config: Config,
  issues: WalkthroughIssues = {},
): Promise<{ walkthrough: Walkthrough; usage: LlmUsage }> {
  const { output: settings } = config;
  // Nothing to assess or pick from means nothing to ask for.
  const linked = settings.assessLinkedIssues && issues.linked?.length ? issues.linked : undefined;
  const candidates = settings.relatedIssues && issues.candidates?.length ? issues.candidates : undefined;
  const extras: WalkthroughExtras = {
    sequenceDiagram: settings.sequenceDiagrams,
    highLevelSummary: settings.highLevelSummary
      ? settings.highLevelSummaryInstructions.trim() || DEFAULT_HIGH_LEVEL_SUMMARY_INSTRUCTIONS
      : undefined,
    linkedIssues: linked,
    candidateIssues: candidates,
  };
  const schema = walkthroughSchemaFor({
    sequenceDiagram: extras.sequenceDiagram,
    highLevelSummary: extras.highLevelSummary !== undefined,
    linkedIssues: !!linked,
    relatedIssues: !!candidates,
  });
  const response = await generateWithFallback(generate, modelChain(config.llm, "walkthrough"), {
    system: WALKTHROUGH_SYSTEM_PROMPT,
    prompt: walkthroughUserPrompt(changeSet, overviewDiff(files), extras),
    schema,
    schemaName: "walkthrough",
    repair: repairWalkthroughOutput,
    temperature: config.llm.temperature,
    // Diagrams, summaries and issue notes need room beyond the overview.
    maxOutputTokens: Math.min(config.llm.maxTokens, extras.sequenceDiagram || extras.highLevelSummary !== undefined || linked || candidates ? 6000 : 4000),
  });
  const known = new Set(changeSet.files.map((file) => file.path));
  const output = response.object as FullWalkthroughOutput;
  const diagram = extras.sequenceDiagram ? diagramSource(output.sequenceDiagram) : undefined;
  const summary = output.highLevelSummary?.trim();
  // Only issues the forge returned are kept, so a reply cannot invent one or
  // link somewhere else.
  const linkedByRef = new Map((linked ?? []).map((issue) => [issue.ref, issue]));
  const candidateByRef = new Map((candidates ?? []).map((issue) => [issue.ref, issue]));
  const issueRef = ({ body: _body, ...ref }: IssueContext) => ref;
  return {
    walkthrough: {
      overview: output.overview.trim(),
      fileSummaries: output.fileSummaries.filter((entry) => known.has(entry.path)),
      labels: output.labels.map((label) => label.trim()).filter(Boolean).slice(0, 5),
      estimatedEffort: Math.min(5, Math.max(1, Math.round(output.estimatedEffort))),
      blastRadius: output.blastRadius,
      ...(diagram ? { sequenceDiagram: diagram } : {}),
      ...(extras.highLevelSummary !== undefined && summary ? { highLevelSummary: summary } : {}),
      ...(linked
        ? {
            linkedIssues: (output.linkedIssues ?? []).flatMap((entry) => {
              const issue = linkedByRef.get(entry.ref.trim());
              if (!issue) return [];
              linkedByRef.delete(issue.ref);
              return [{ ...issueRef(issue), assessment: entry.assessment, note: entry.note.trim() }];
            }),
          }
        : {}),
      ...(candidates
        ? {
            relatedIssues: (output.relatedIssues ?? []).flatMap((entry) => {
              const issue = candidateByRef.get(entry.ref.trim());
              if (!issue) return [];
              candidateByRef.delete(issue.ref);
              return [{ ...issueRef(issue), reason: entry.reason.trim() }];
            }),
          }
        : {}),
    },
    usage: {
      purpose: "walkthrough",
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      latencyMs: response.latencyMs,
    },
  };
}
