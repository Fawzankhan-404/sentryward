import { Bot, Copy, ExternalLink } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { copyToClipboard } from "@/lib/clipboard"
import { findingPrompt } from "./agentPrompt"
import { findingLines, forgeFileUrl } from "./links"
import type { Finding, ReviewResult } from "./types"

// A finding's full text, shared by the review page's cards and the findings sheet.
export function FindingBody({ finding, change }: { finding: Finding; change: ReviewResult["change"] }) {
  const lines = findingLines(finding)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{finding.category}</Badge>
        {finding.kind !== "potential_issue" && <Badge variant="outline">{finding.kind.replace(/_/g, " ")}</Badge>}
        {/* An analyzer's result has no confidence of its own; name the analyzer instead. */}
        {finding.source === "tool" ? (
          <Badge variant="secondary">via {finding.tool ?? "static analysis"}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground">
            Confidence {Math.round(finding.confidence * 100)}% · {finding.effort.replace(/_/g, " ")}
          </span>
        )}
        <a
          href={forgeFileUrl(change, finding.file, finding.startLine, finding.endLine)}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 font-mono text-xs text-muted-foreground hover:underline"
        >
          {finding.file}:{lines}
          <ExternalLink className="size-3" />
        </a>
      </div>
      {/* Model text is shown as plain text; it is never rendered as HTML. */}
      <p className="text-sm whitespace-pre-wrap">{finding.body}</p>
      {finding.evidenceNote && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Evidence ({finding.evidence.replace(/_/g, " ")}):</span>{" "}
          {finding.evidenceNote}
        </p>
      )}
      {finding.suggestion && (
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-10 text-xs">
            <code>{finding.suggestion}</code>
          </pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1 right-1 size-7"
            aria-label="Copy suggestion"
            onClick={() => copyToClipboard(finding.suggestion!, "Suggestion")}
          >
            <Copy />
          </Button>
        </div>
      )}
      <div>
        <Button variant="outline" size="sm" onClick={() => copyToClipboard(findingPrompt(finding), "Agent prompt")}>
          <Bot />
          Copy agent prompt
        </Button>
      </div>
    </>
  )
}
