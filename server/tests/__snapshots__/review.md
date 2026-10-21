## Summary

Adds b and c.

🏷️ Labels: `feature` · ⏱️ Review effort: 1/5 · 💥 Blast radius: small

<details>
<summary>📂 Changes (1 file)</summary>

| File | Summary |
| --- | --- |
| `src/app.ts` | Two new constants. |

</details>

⛔ **Blocked**: 1 finding at or above critical.

- 🔴 **critical** `src/app.ts:11`: SQL built from @​input

4 findings (1 critical, 1 major, 2 minor): 2 actionable, 2 in the sections below.

<details>
<summary>🛠️ Actionable comments (2)</summary>

- 🔴 **critical** `src/app.ts:11`: SQL built from @​input
- 🔵 **minor** `src/app.ts:12`: c is never negative

</details>

<details>
<summary>📍 Outside diff range comments (1)</summary>

#### `src/app.ts:40`: Caller ignores &lt;result&gt;

🟠 *major · bug · potential issue*

Adding one can exceed the safe integer range.

**🔎 Evidence:** x | y

</details>

<details>
<summary>🧹 Nitpick comments (1)</summary>

#### `src/app.ts:12`: Name c more clearly

🔵 *minor · bug · nitpick*

Adding one can exceed the safe integer range.

**🔎 Evidence:** main() is called with Number.MAX_SAFE_INTEGER from the CLI.

</details>

<details>
<summary>🤖 Prompt for AI agents (4 findings)</summary>

```
Verify each finding against the current code and only fix it if it still applies. Ordered by severity, most severe first.

1. [critical] src/app.ts:11 - SQL built from @​input
Adding one can exceed the safe integer range.
Suggested replacement:
----
db.query(sql, [b]);
----

2. [major] src/app.ts:40 - Caller ignores <result>
Adding one can exceed the safe integer range.

3. [minor] src/app.ts:12 - c is never negative
Adding one can exceed the safe integer range.

4. [minor] src/app.ts:12 - Name c more clearly
Adding one can exceed the safe integer range.
```

</details>

<details>
<summary>🚫 Not reviewed (1 item)</summary>

- `package-lock.json`: ignored by configuration

</details>

**📝 Notes**

- .sentryward.yaml was ignored: review: unknown setting nope

<sub>Reviewed `head` with anthropic/claude-sonnet-5-5 · 1 review pass · 1 file reviewed</sub>

<sub><img src="https://raw.githubusercontent.com/rdlugs/sentryward/main/client/public/sentryward-32.png" alt="" width="14" height="14" align="absmiddle"> Sentryward</sub>

<!-- sentryward:summary -->
