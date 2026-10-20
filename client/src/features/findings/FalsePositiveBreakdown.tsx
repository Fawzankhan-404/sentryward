import type { ReactNode } from "react"
import { Link } from "react-router"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SeverityBadge } from "@/features/reviews/badges"
import { useFindingStats } from "./api"
import { CATEGORY_LABEL } from "./options"
import type { FalsePositiveRow } from "./types"

// Below this a rate is mostly noise: one dismissal out of two reads as 50%.
export const MIN_FOUND = 5
// At or above this a row earns a hint at the setting that would quiet it.
export const NOISY_RATE = 30

interface Group<K> {
  label: string
  rows: FalsePositiveRow<K>[]
  name: (key: K) => ReactNode
  hint: (key: K) => { text: string; to: string } | null
}

function hintLink(hint: { text: string; to: string } | null) {
  if (!hint) return null
  return (
    <Link to={hint.to} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
      {hint.text}
    </Link>
  )
}

function GroupTable<K>({ label, rows, name, hint }: Group<K>) {
  const shown = rows.filter((row) => row.found >= MIN_FOUND)
  const hidden = rows.length - shown.length
  return (
    <div className="flex flex-col gap-2">
      <Table aria-label={`False positives by ${label.toLowerCase()}`}>
        <TableHeader>
          <TableRow>
            <TableHead>{label}</TableHead>
            <TableHead className="text-right">Found</TableHead>
            <TableHead className="text-right">False positives</TableHead>
            <TableHead className="text-right">Rate</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => (
            <TableRow key={String(row.key)}>
              <TableCell>
                <div className="flex flex-col items-start gap-0.5">
                  {name(row.key)}
                  {row.rate !== null && row.rate >= NOISY_RATE && hintLink(hint(row.key))}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">{row.found}</TableCell>
              <TableCell className="text-right tabular-nums">{row.falsePositives}</TableCell>
              <TableCell className="text-right tabular-nums">{row.rate === null ? "-" : `${row.rate}%`}</TableCell>
            </TableRow>
          ))}
          {shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                Not enough findings yet
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">
          {hidden} {hidden === 1 ? "row" : "rows"} with fewer than {MIN_FOUND} findings hidden
        </p>
      )}
    </div>
  )
}

const findingTypes = "/configuration?tab=findings"

// Where the overall false-positive rate comes from, with a pointer to the
// setting that would quiet the noisiest groups. Rides on the stats query, so
// it costs no extra request and stays out of the way if that fails.
export function FalsePositiveBreakdown() {
  const { data, isPending, isError } = useFindingStats()
  if (isPending || isError || data.found === 0) return null

  const by = data.falsePositivesBy
  return (
    <Card aria-label="False positive breakdown" role="region">
      <CardHeader>
        <CardTitle>Where false positives come from</CardTitle>
        <CardDescription>Findings first seen in the last {data.days} days, ignored ones included.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-3">
        <GroupTable
          label="Category"
          rows={by.category}
          name={(key) => CATEGORY_LABEL[key] ?? key}
          hint={(key) => ({ text: `Drop ${CATEGORY_LABEL[key] ?? key} from the reviewed categories`, to: findingTypes })}
        />
        <GroupTable
          label="Severity"
          rows={by.severity}
          name={(key) => <SeverityBadge severity={key} />}
          // Low-severity noise is what the confidence and severity floors are for;
          // a noisy critical needs a better prompt, not a setting.
          hint={(key) =>
            key === "minor" || key === "info" ? { text: "Raise the minimum confidence or severity floor", to: findingTypes } : null
          }
        />
        <GroupTable
          label="Model"
          rows={by.model}
          name={(key) => (key === null ? <span className="text-muted-foreground">Unknown</span> : <code className="text-xs">{key}</code>)}
          hint={(key) => (key === null ? null : { text: "Try another model", to: "/configuration?tab=llm" })}
        />
      </CardContent>
    </Card>
  )
}
