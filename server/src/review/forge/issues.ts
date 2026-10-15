import { escapeRegExp } from "../core/regex.ts";

// Shared by the forge adapters' issue lookups: which issues a description says
// it closes, and which words of a title are worth searching for.

// At most this many issues are read for each lookup, so a description listing
// dozens of references or a busy tracker cannot blow up the walkthrough prompt.
export const MAX_LINKED_ISSUES = 5;
export const MAX_CANDIDATE_ISSUES = 10;
const MAX_SEARCH_TERMS = 4;

const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+((?:[\w.-]+\/[\w.-]+)?#\d+|https?:\/\/\S+\/issues\/\d+)/gi;

// Issue numbers the description closes with GitHub's keywords ("fixes #12",
// "closes owner/repo#12", "resolves https://host/owner/repo/issues/12"). Only
// this repository's issues count; a reference elsewhere cannot be read with
// this connection's access anyway.
export function closingIssueNumbers(description: string, project: string, host: string): number[] {
  const sameRepoUrl = new RegExp(`^https?://${escapeRegExp(host.replace(/^https?:\/\//, ""))}/${escapeRegExp(project)}/issues/(\\d+)$`, "i");
  const numbers: number[] = [];
  for (const match of description.matchAll(CLOSING)) {
    const reference = match[1]!.replace(/[).,;]+$/, "");
    let number: string | undefined;
    if (reference.startsWith("http")) {
      number = sameRepoUrl.exec(reference)?.[1];
    } else {
      const [repo, n] = reference.split("#");
      if (!repo || repo.toLowerCase() === project.toLowerCase()) number = n;
    }
    const parsed = Number(number);
    if (number && !numbers.includes(parsed)) numbers.push(parsed);
    if (numbers.length >= MAX_LINKED_ISSUES) break;
  }
  return numbers;
}

const STOPWORDS = new Set(
  "about after also adds added adding allow allows change changes changed from into make makes more only some that than then them they this when with without update updates updated support supports use uses using fix fixes fixed refactor feat chore docs test tests wip draft".split(
    " ",
  ),
);

// The distinctive words of a title, in order, for a keyword search of the
// tracker. Short and common words match nearly every issue.
export function searchTerms(title: string): string[] {
  const words = title
    .toLowerCase()
    .replace(/^\w+(\([^)]*\))?!?:\s*/, "")
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !/^\d+$/.test(word));
  return [...new Set(words)].slice(0, MAX_SEARCH_TERMS);
}
