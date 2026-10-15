import type { ConfigOverride, ProfileName } from "./schema.ts";

// Presets sit directly above the defaults, so any field a user sets anywhere
// else wins over the profile without special handling.
export const PROFILES: Record<ProfileName, ConfigOverride> = {
  // The defaults as they are.
  balanced: {},
  // One model call per pass and fewer passes: no walkthrough or verification.
  fast: {
    review: { maxChunks: 4, verify: "off" },
    output: { walkthrough: false },
  },
  // Majors block, more findings are kept, low-confidence ones still dropped.
  strict: {
    review: { blockOn: "major", maxFindings: 40, minConfidence: 0.6 },
  },
  // Security and reliability only, and majors block.
  security: {
    review: { categories: ["security", "reliability"], blockOn: "major" },
  },
};
