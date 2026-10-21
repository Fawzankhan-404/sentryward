// Hidden HTML comments Sentryward leaves in what it posts, so a later run can find
// its own summary and tell which findings it already commented on.

export const SUMMARY_MARKER = "<!-- sentryward:summary -->";
// Every reply Sentryward posts in a finding's thread, so a webhook for it is
// never mistaken for a person's reply, even under another login.
export const REPLY_MARKER = "<!-- sentryward:reply -->";
// A walkthrough posted as a comment of its own.
export const WALKTHROUGH_MARKER = "<!-- sentryward:walkthrough -->";
// Earlier versions wrote the walkthrough into the PR/MR description between
// these. It now lives in the review comment; the markers remain so a change
// read from the forge, and the description itself, can be cleaned of it.
export const DESCRIPTION_START = "<!-- sentryward:walkthrough:start -->";
export const DESCRIPTION_END = "<!-- sentryward:walkthrough:end -->";

// The high-level summary (output.highLevelSummary) written into the
// description; a run replaces the block it finds.
export const DESCRIPTION_SUMMARY_START = "<!-- sentryward:summary:start -->";
export const DESCRIPTION_SUMMARY_END = "<!-- sentryward:summary:end -->";

const LEGACY_BLOCK = /\n*<!-- sentryward:walkthrough:start -->[\s\S]*?<!-- sentryward:walkthrough:end -->\n*/g;
const SUMMARY_BLOCK = /\n*<!-- sentryward:summary:start -->[\s\S]*?<!-- sentryward:summary:end -->\n*/g;

// The description without Sentryward's blocks, so a review never reads its own
// earlier summary as the author's intent.
export function withoutDescriptionBlock(description: string): string {
  return description.replace(LEGACY_BLOCK, "\n\n").replace(SUMMARY_BLOCK, "\n\n").trim();
}

// The description Sentryward leaves behind: `summary` as its only block, at the
// end; or, when `summary` is null, the current summary block kept (a run
// without one, such as a failed walkthrough, does not erase it); or, when
// `summary` is "", no block at all. Exactly the input when nothing changes, so
// the author's own text never triggers an edit.
export function withDescriptionSummary(description: string, summary: string | null): string {
  let next: string;
  if (summary === null) {
    next = description.replace(LEGACY_BLOCK, "\n\n").trim();
  } else {
    const base = withoutDescriptionBlock(description);
    next = summary ? (base ? `${base}\n\n${summary}` : summary) : base;
  }
  return next === description.trim() ? description : next;
}

const FINGERPRINT_MARKER = /<!-- sentryward:fp=([0-9a-f]{16}) -->/g;

export function fingerprintMarker(fingerprint: string): string {
  return `<!-- sentryward:fp=${fingerprint} -->`;
}

export function markersIn(body: string): string[] {
  return [...body.matchAll(FINGERPRINT_MARKER)].map((match) => match[1]!);
}
