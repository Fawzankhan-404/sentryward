import { useEffect, useMemo, useState } from "react"
import { AlertTriangle } from "lucide-react"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { TablePagination } from "@/components/TablePagination"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { ALL, selectedLabel } from "@/lib/filters"
import { useRepos } from "@/features/forge/api"
import { useFindings, type FindingQuery } from "@/features/findings/api"
import { FindingDetailsSheet } from "@/features/findings/FindingDetailsSheet"
import { FalsePositiveBreakdown } from "@/features/findings/FalsePositiveBreakdown"
import { FindingStatsStrip } from "@/features/findings/FindingStatsStrip"
import { FindingsTable } from "@/features/findings/FindingsTable"
import { CATEGORY_OPTIONS, KIND_OPTIONS, SEVERITY_OPTIONS, STATE_OPTIONS } from "@/features/findings/options"
import type { FindingRow, FindingSortKey } from "@/features/findings/types"

const only = <T extends string>(value: string) => (value === ALL ? undefined : (value as T))

// Open findings are the ones waiting on someone, so the list starts there.
const DEFAULT_STATE = "open"

export function FindingsPage() {
  const pagination = usePagination()
  const [state, setState] = useState<string>(DEFAULT_STATE)
  const [severity, setSeverity] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [kind, setKind] = useState(ALL)
  const [repo, setRepo] = useState(ALL)
  const [query, setQuery] = useState("")
  const [opened, setOpened] = useState<FindingRow | null>(null)
  const { sort, onSort } = useSort<FindingSortKey>()
  const q = useDebounced(query.trim())

  const repos = useRepos()
  const repoOptions = useMemo(
    () =>
      (repos.data?.repos ?? [])
        .map((r) => ({ value: r.id, label: r.fullPath }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [repos.data],
  )

  const params: FindingQuery = {
    state: only<NonNullable<FindingQuery["state"]>>(state),
    severity: only<NonNullable<FindingQuery["severity"]>>(severity),
    category: only<NonNullable<FindingQuery["category"]>>(category),
    kind: only<NonNullable<FindingQuery["kind"]>>(kind),
    repoId: only(repo),
    q: q || undefined,
    // Unsorted leaves the server's default: most recently seen first.
    sort: sort?.key,
    dir: sort?.dir,
    page: pagination.page,
    limit: pagination.size,
  }
  const { data, isPending, isError } = useFindings(params)
  // A page past the end (e.g. after ignoring the last row) falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  const filtering = state !== ALL || severity !== ALL || category !== ALL || kind !== ALL || repo !== ALL
  const narrowed = filtering || q !== ""
  // The list opens on the Open filter, so an empty default view means nothing
  // is open, not that the filters missed.
  const onlyDefault = q === "" && state === DEFAULT_STATE && [severity, category, kind, repo].every((v) => v === ALL)
  const emptyMessage = !narrowed
    ? "No findings yet. Findings from your reviews will show up here."
    : onlyDefault
      ? "No open findings."
      : "No findings match your filters."

  // A new filter, search or sort starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      pagination.setPage(1)
    }
  }

  function clearFilters() {
    setState(ALL)
    setSeverity(ALL)
    setCategory(ALL)
    setKind(ALL)
    setRepo(ALL)
    pagination.setPage(1)
  }

  const activeFilters = [
    { label: "State", value: selectedLabel(state, STATE_OPTIONS), onRemove: () => filterBy(setState)(ALL) },
    { label: "Severity", value: selectedLabel(severity, SEVERITY_OPTIONS), onRemove: () => filterBy(setSeverity)(ALL) },
    { label: "Category", value: selectedLabel(category, CATEGORY_OPTIONS), onRemove: () => filterBy(setCategory)(ALL) },
    { label: "Type", value: selectedLabel(kind, KIND_OPTIONS), onRemove: () => filterBy(setKind)(ALL) },
    { label: "Repository", value: selectedLabel(repo, repoOptions), onRemove: () => filterBy(setRepo)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <PageShell>
      <PageHeader
        title="Findings"
        description="Issues raised across your reviews, tracked until they are resolved or ignored."
      />
      <FindingStatsStrip />
      <FalsePositiveBreakdown />
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <FilterPopover active={filtering} onClear={clearFilters}>
          <FilterSelect
            id="finding-state"
            label="State"
            allLabel="All states"
            value={state}
            onValueChange={filterBy(setState)}
            options={STATE_OPTIONS}
          />
          <FilterSelect
            id="finding-severity"
            label="Severity"
            allLabel="All severities"
            value={severity}
            onValueChange={filterBy(setSeverity)}
            options={SEVERITY_OPTIONS}
          />
          <FilterSelect
            id="finding-category"
            label="Category"
            allLabel="All categories"
            value={category}
            onValueChange={filterBy(setCategory)}
            options={CATEGORY_OPTIONS}
          />
          <FilterSelect
            id="finding-kind"
            label="Type"
            allLabel="All types"
            value={kind}
            onValueChange={filterBy(setKind)}
            options={KIND_OPTIONS}
          />
          {repoOptions.length > 1 && (
            <FilterSelect
              id="finding-repo"
              label="Repository"
              allLabel="All repositories"
              value={repo}
              onValueChange={filterBy(setRepo)}
              options={repoOptions}
            />
          )}
        </FilterPopover>
        <SearchInput label="Search findings" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      {isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load findings.</AlertTitle>
        </Alert>
      ) : (
        <Card>
          <CardContent>
            <FindingsTable
              findings={data.findings}
              sort={sort}
              onSort={filterBy(onSort)}
              onOpen={setOpened}
              emptyMessage={emptyMessage}
            />
            {data.total > 0 && (
              <TablePagination
                page={Math.min(pagination.page, lastPage)}
                size={pagination.size}
                total={data.total}
                onPageChange={pagination.setPage}
                onSizeChange={pagination.setSize}
              />
            )}
          </CardContent>
        </Card>
      )}
      <FindingDetailsSheet row={opened} onOpenChange={(open) => !open && setOpened(null)} />
    </PageShell>
  )
}
