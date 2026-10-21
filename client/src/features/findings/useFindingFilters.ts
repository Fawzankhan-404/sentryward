import { useState } from "react"
import type { ActiveFilter } from "@/components/TableFilters"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { ALL, selectedLabel } from "@/lib/filters"
import type { FindingQuery } from "./api"
import { CATEGORY_OPTIONS, KIND_OPTIONS, SEVERITY_OPTIONS, STATE_OPTIONS } from "./options"
import type { FindingSortKey } from "./types"

const only = <T extends string>(value: string) => (value === ALL ? undefined : (value as T))

type RepoOption = { value: string; label: string }

// Filters, search, sort and paging for one findings list. The page holds one
// per tab, above the tabs, so each keeps its own and both survive switching.
export function useFindingFilters(repoOptions: RepoOption[], paginationPrefix?: string) {
  const pagination = usePagination(paginationPrefix)
  const [state, setState] = useState(ALL)
  const [severity, setSeverity] = useState(ALL)
  const [category, setCategory] = useState(ALL)
  const [kind, setKind] = useState(ALL)
  const [repo, setRepo] = useState(ALL)
  const [query, setQuery] = useState("")
  const { sort, onSort } = useSort<FindingSortKey>()
  const q = useDebounced(query.trim())

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

  const filtering = state !== ALL || severity !== ALL || category !== ALL || kind !== ALL || repo !== ALL
  const narrowed = filtering || q !== ""

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

  return {
    values: { state, severity, category, kind, repo, query },
    setters: { setState, setSeverity, setCategory, setKind, setRepo, setQuery },
    params,
    sort,
    onSort,
    pagination,
    filtering,
    narrowed,
    filterBy,
    clearFilters,
    activeFilters,
  }
}

export type FindingFilters = ReturnType<typeof useFindingFilters>
