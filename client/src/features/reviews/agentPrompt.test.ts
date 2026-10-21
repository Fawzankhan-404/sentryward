import { describe, expect, it } from "vitest"
import { result } from "@/test/fixtures"
import { allFindingsPrompt, findingPrompt } from "./agentPrompt"

describe("agent prompts", () => {
  it("describes one finding the way the forge comment does", () => {
    const finding = { ...result.findings[0], startLine: 11, endLine: 14 }
    expect(findingPrompt(finding)).toBe(
      [
        "In src/app.ts around lines 11-14: SQL injection in search",
        "",
        "Why it matters.",
        "",
        "Suggested replacement for those lines:",
        "",
        "db.query(sql, [q])",
        "",
        "Verify this against the current code first; it may already be fixed.",
      ].join("\n"),
    )
  })

  it("numbers every finding by severity, then file and line", () => {
    const prompt = allFindingsPrompt([...result.findings].reverse())
    expect(prompt.startsWith("Verify each finding against the current code")).toBe(true)
    expect(prompt).toContain(
      [
        "1. [critical] src/app.ts:11 - SQL injection in search",
        "Why it matters.",
        "Suggested replacement:",
        "----",
        "db.query(sql, [q])",
        "----",
        "",
      ].join("\n"),
    )
    expect(prompt).toContain("2. [major] src/app.ts:40 - Caller ignores result")
    expect(prompt).toContain("3. [minor] src/app.ts:11 - Rename c")
  })
})
