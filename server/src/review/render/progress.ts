import type { ChangeSet } from "../core/models.ts";
import { SUMMARY_MARKER } from "../core/markers.ts";
import { FORGE_INFO } from "../forge/providers.ts";
import { STATUS_CONTEXT } from "../forge/types.ts";
import { BRAND_FOOTER } from "./markdown.ts";

// What this run will publish, so the placeholder only promises what arrives.
export interface ProgressOutputs {
  walkthrough: boolean;
  inline: boolean;
  status: boolean;
}

// Posted when a review starts and replaced by the summary when it ends; it
// carries the summary marker so the replacement edits this same comment. No
// heading: it is a status note, not an (empty) report.
export function progressMarkdown(changeSet: ChangeSet, outputs: ProgressOutputs): string {
  const { provider, headSha, webUrl } = changeSet.forgeRef;
  const short = `\`${headSha.slice(0, 7)}\``;
  const sha = webUrl ? `[${short}](${FORGE_INFO[provider].commitUrl(webUrl, headSha)})` : short;
  const parts = [outputs.walkthrough ? "a walkthrough and summary here" : "a summary here"];
  if (outputs.inline) parts.push("findings as inline comments on the diff");
  if (outputs.status) parts.push(`the \`${STATUS_CONTEXT}\` commit status`);
  return [
    `⏳ **Reviewing ${sha}**`,
    "",
    `<sub>This comment will be replaced with the review when it finishes: ${list(parts)}.</sub>`,
    "",
    BRAND_FOOTER,
    "",
    SUMMARY_MARKER,
    "",
  ].join("\n");
}

function list(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0]!;
}
