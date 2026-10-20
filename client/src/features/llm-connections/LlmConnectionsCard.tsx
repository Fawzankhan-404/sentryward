import { useMemo, useState, type ReactNode } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { KeyRound, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { SearchableSelect } from "@/components/SearchableSelect"
import { SortableHead } from "@/components/SortableHead"
import { TablePagination } from "@/components/TablePagination"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  NoMatchesRow,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { paginate, usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import {
  useApiKeys,
  useApiKeyStatuses,
  useDeleteApiKey,
  useSaveApiKey,
  STATUS_LABELS,
  type ApiKey,
  type LlmConnectionStatus,
  type LlmProvider,
} from "./api"
import { ApiKeyStatusBadge } from "./ApiKeyStatusBadge"
import { LLM_PROVIDERS } from "./providers"

type KeyInput = { apiKey: string; baseUrl: string }

function isHttpUrl(value: string) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function keySchema(provider: LlmProvider, customHost: boolean) {
  return z
    .object({ apiKey: z.string().trim().max(500), baseUrl: z.string().trim().max(500) })
    .superRefine((value, context) => {
      if (provider !== "ollama" && value.apiKey.length < 8) {
        context.addIssue({ code: "custom", path: ["apiKey"], message: "That does not look like an API key" })
      }
      if (customHost && !isHttpUrl(value.baseUrl)) {
        context.addIssue({ code: "custom", path: ["baseUrl"], message: "Enter an http or https URL" })
      }
    })
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" }) : null
}

function KeyForm({ credential, onSaved }: { credential: ApiKey; onSaved: () => void }) {
  const save = useSaveApiKey()
  const provider = LLM_PROVIDERS[credential.provider]
  const [customHost, setCustomHost] = useState(credential.provider === "ollama" || Boolean(credential.baseUrl))
  const form = useForm<KeyInput>({
    resolver: zodResolver(keySchema(credential.provider, customHost)),
    defaultValues: {
      apiKey: "",
      baseUrl: credential.baseUrl ?? provider.defaultBaseUrl ?? "",
    },
  })

  async function onSubmit(values: KeyInput) {
    try {
      await save.mutateAsync({
        provider: credential.provider,
        apiKey: values.apiKey.trim() || undefined,
        baseUrl: customHost ? values.baseUrl.trim() : undefined,
      })
      toast.success(`${provider.label} connection verified and saved`)
      onSaved()
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-5">
      <FieldGroup>
        {credential.provider !== "ollama" && (
          <Field orientation="horizontal">
            <FieldLabel htmlFor="custom-host">Use custom host</FieldLabel>
            <Switch
              id="custom-host"
              checked={customHost}
              onCheckedChange={setCustomHost}
              aria-label="Use custom host"
            />
          </Field>
        )}
        {customHost && (
          <>
            <TextField
              control={form.control}
              name="baseUrl"
              label="API base URL"
              type="url"
              placeholder={provider.defaultBaseUrl ?? "https://api.example.com/v1"}
            />
            {credential.provider === "ollama" && (
              <FieldDescription>
                From Docker, use <code>host.docker.internal</code> for Ollama running on this machine.
              </FieldDescription>
            )}
          </>
        )}
        <TextField
          control={form.control}
          name="apiKey"
          label={`${provider.label} API key${credential.provider === "ollama" ? " (optional)" : ""}`}
          type="password"
          autoComplete="off"
          placeholder={provider.keyPlaceholder}
        />
      </FieldGroup>
      <Button type="submit" disabled={form.formState.isSubmitting}>
        {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
        {form.formState.isSubmitting
          ? "Checking connection..."
          : credential.stored
            ? "Check and replace"
            : "Check and save"}
      </Button>
    </form>
  )
}

function defaultProvider(keys: ApiKey[], preferred?: LlmProvider) {
  return preferred ?? keys.find((key) => !key.stored)?.provider ?? keys[0]!.provider
}

function AddConnectionSheet({
  keys,
  open,
  initialProvider,
  onOpenChange,
}: {
  keys: ApiKey[]
  open: boolean
  initialProvider?: LlmProvider
  onOpenChange: (open: boolean) => void
}) {
  const [picked, setPicked] = useState<LlmProvider | null>(null)
  const providerId = picked ?? defaultProvider(keys, initialProvider)
  const credential = keys.find((key) => key.provider === providerId)!

  function handleOpenChange(next: boolean) {
    if (!next) setPicked(null)
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Add connection</SheetTitle>
          <SheetDescription>Choose a provider and verify its credentials. Keys are encrypted at rest.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-4">
          <Field>
            <FieldLabel htmlFor="provider">Provider</FieldLabel>
            <SearchableSelect
              id="provider"
              value={providerId}
              onValueChange={(value) => setPicked(value as LlmProvider)}
              options={keys.map((key) => ({
                value: key.provider,
                label: LLM_PROVIDERS[key.provider].label,
                icon: LLM_PROVIDERS[key.provider].icon,
              }))}
            />
          </Field>
          <Separator />
          <section className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {LLM_PROVIDERS[providerId].keyUrl
                ? `Create a key at ${LLM_PROVIDERS[providerId].keyUrl}.`
                : "Connect to an Ollama server that exposes its OpenAI-compatible API."}
              {credential.stored
                ? credential.undecryptable
                  ? " The stored key can't be decrypted (the server's encryption key changed). Saving replaces it."
                  : credential.last4
                    ? ` A key ending in ${credential.last4} is stored. Saving replaces it.`
                    : " A host without an API key is stored."
                : credential.serverDefault
                  ? " Reviews currently use the server's key."
                  : ""}
            </p>
            <KeyForm key={providerId} credential={credential} onSaved={() => handleOpenChange(false)} />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

type SortKey = "provider" | "host" | "status" | "updatedAt"

// Problems first when sorting ascending; still-checking rows go last.
const STATUS_RANK: Record<LlmConnectionStatus, number> = { revoked: 0, unreachable: 1, active: 2 }

const STATUS_OPTIONS = (Object.keys(STATUS_RANK) as LlmConnectionStatus[])
  .sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])
  .map((status) => ({ value: status, label: STATUS_LABELS[status] }))

const PROVIDER_OPTIONS = (Object.keys(LLM_PROVIDERS) as LlmProvider[]).map((provider) => ({
  value: provider,
  label: LLM_PROVIDERS[provider].label,
  icon: LLM_PROVIDERS[provider].icon,
}))

type KeyStatuses = Partial<Record<LlmProvider, LlmConnectionStatus | undefined>>

function compareKeys(
  a: ApiKey,
  b: ApiKey,
  key: SortKey,
  statuses: KeyStatuses,
) {
  // An unreadable key is the most urgent problem, ahead of a revoked one.
  const rank = (apiKey: ApiKey) => {
    if (apiKey.undecryptable) return -1
    const status = statuses[apiKey.provider]
    return status ? STATUS_RANK[status] : 3
  }
  switch (key) {
    case "provider":
      return LLM_PROVIDERS[a.provider].label.localeCompare(LLM_PROVIDERS[b.provider].label)
    case "host":
      return (a.baseUrl ?? "").localeCompare(b.baseUrl ?? "")
    case "status":
      return rank(a) - rank(b)
    case "updatedAt":
      return Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? "")
  }
}

function KeyActions({ apiKey, onReplace, onRemove }: { apiKey: ApiKey; onReplace: () => void; onRemove: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={`Actions for ${LLM_PROVIDERS[apiKey.provider].label}`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onReplace}>
          <RefreshCw />
          Replace
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Rendered once beside the table rather than inside the row menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
function RemoveKeyDialog({ apiKey, onOpenChange }: { apiKey: ApiKey | null; onOpenChange: (open: boolean) => void }) {
  const remove = useDeleteApiKey()
  const label = apiKey ? LLM_PROVIDERS[apiKey.provider].label : ""

  async function onRemove() {
    if (!apiKey) return
    try {
      await remove.mutateAsync(apiKey.provider)
      onOpenChange(false)
      toast.success(`${label} key removed`)
    } catch {
      toast.error("Could not remove the key")
    }
  }

  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {apiKey && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {label} connection?</DialogTitle>
              <DialogDescription>
                The stored key and API host are deleted. You can add a new {label} connection at any time.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
                {remove.isPending && <Loader2 className="animate-spin" />}
                Remove connection
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function KeysTable({
  keys,
  statuses,
  onReplace,
}: {
  keys: ApiKey[]
  statuses: KeyStatuses
  onReplace: (provider: LlmProvider) => void
}) {
  // Unsorted keeps the API order (the provider list order).
  const { sort, onSort } = useSort<SortKey>()
  const [removing, setRemoving] = useState<ApiKey | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return keys
    const direction = sort.dir === "asc" ? 1 : -1
    return [...keys].sort(
      (a, b) =>
        direction * compareKeys(a, b, sort.key, statuses) ||
        LLM_PROVIDERS[a.provider].label.localeCompare(LLM_PROVIDERS[b.provider].label),
    )
  }, [keys, sort, statuses])
  const pagination = usePagination()
  const page = paginate(sorted, pagination.page, pagination.size)

  const head = { sort, onSort }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Provider" sortKey="provider" {...head} />
            <TableHead>Key</TableHead>
            <SortableHead label="Host" sortKey="host" {...head} />
            <SortableHead label="Status" sortKey="status" {...head} />
            <SortableHead label="Updated" sortKey="updatedAt" {...head} />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={6}>No connections match your filters.</NoMatchesRow>}
          {page.rows.map((key) => {
            const provider = LLM_PROVIDERS[key.provider]
            return (
              <TableRow key={key.provider}>
                <TableCell>
                  <Badge variant="outline">
                    <provider.icon />
                    {provider.label}
                  </Badge>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {key.undecryptable ? "Unreadable" : key.last4 ? `••••${key.last4}` : "None"}
                </TableCell>
                <TableCell className="break-all text-muted-foreground">{key.baseUrl ?? "Default"}</TableCell>
                <TableCell>
                  {key.undecryptable ? (
                    <Badge
                      variant="outline"
                      className="border-destructive/40 text-destructive"
                      title="The server's encryption key changed, so this key can't be read; replace it"
                    >
                      <span className="size-1.5 rounded-full bg-current" aria-hidden />
                      Re-enter key
                    </Badge>
                  ) : (
                    <ApiKeyStatusBadge status={statuses[key.provider]} />
                  )}
                </TableCell>
                <TableCell
                  className="text-muted-foreground"
                  title={key.updatedAt ? new Date(key.updatedAt).toLocaleString() : undefined}
                >
                  {formatDate(key.updatedAt)}
                </TableCell>
                <TableCell className="text-right">
                  <KeyActions apiKey={key} onReplace={() => onReplace(key.provider)} onRemove={() => setRemoving(key)} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <TablePagination
        page={page.page}
        size={pagination.size}
        total={page.total}
        onPageChange={pagination.setPage}
        onSizeChange={pagination.setSize}
      />
      <RemoveKeyDialog apiKey={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

// The search and filters sit above the card, so their state lives here and
// the table only sorts what it is given.
function ConnectedKeys({
  keys,
  addButton,
  onReplace,
}: {
  keys: ApiKey[]
  addButton: ReactNode
  onReplace: (provider: LlmProvider) => void
}) {
  // An unreadable key has nothing to send the provider, so it is not checked.
  const statuses = useApiKeyStatuses(keys.filter((key) => !key.undecryptable))
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const filtering = provider !== ALL || status !== ALL

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  function clearFilters() {
    setProvider(ALL)
    setStatus(ALL)
    setPage(1)
  }

  const filtered = useMemo(
    () =>
      keys.filter(
        (key) =>
          matchesQuery(query, LLM_PROVIDERS[key.provider].label, key.baseUrl ?? "", key.last4 ?? "") &&
          (provider === ALL || key.provider === provider) &&
          // Keys still being checked match no specific status.
          (status === ALL || statuses[key.provider] === status),
      ),
    [keys, query, provider, status, statuses],
  )

  const activeFilters = [
    {
      label: "Provider",
      value: selectedLabel(provider, PROVIDER_OPTIONS),
      onRemove: () => filterBy(setProvider)(ALL),
    },
    { label: "Status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => filterBy(setStatus)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <FilterPopover active={filtering} onClear={clearFilters}>
          <FilterSelect
            id="llm-provider"
            label="Provider"
            allLabel="All providers"
            value={provider}
            onValueChange={filterBy(setProvider)}
            options={PROVIDER_OPTIONS}
          />
          <FilterSelect
            id="llm-status"
            label="Status"
            allLabel="All statuses"
            value={status}
            onValueChange={filterBy(setStatus)}
            options={STATUS_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search connections" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Connections</CardTitle>
          <CardDescription>Only verified connections are used for reviews.</CardDescription>
          <CardAction>{addButton}</CardAction>
        </CardHeader>
        <CardContent>
          <KeysTable keys={filtered} statuses={statuses} onReplace={onReplace} />
        </CardContent>
      </Card>
    </>
  )
}

export function LlmConnectionsCard() {
  const { data, isPending, error } = useApiKeys()
  const [sheet, setSheet] = useState<{ open: boolean; provider?: LlmProvider }>({ open: false })

  if (isPending) return null
  if (error || !data) return <p className="text-sm text-destructive">Could not load your API keys.</p>

  const stored = data.keys.filter((key) => key.stored)
  const openSheet = (provider?: LlmProvider) => setSheet({ open: true, provider })
  const addButton = (
    <Button size={stored.length ? "sm" : "default"} disabled={!data.keys.length} onClick={() => openSheet()}>
      <Plus />
      Add Connection
    </Button>
  )
  const sheetElement = data.keys.length ? (
    <AddConnectionSheet
      keys={data.keys}
      open={sheet.open}
      initialProvider={sheet.provider}
      onOpenChange={(open) => setSheet((current) => ({ ...current, open }))}
    />
  ) : null

  if (!stored.length) {
    const serverKeys = data.keys.filter((key) => key.serverDefault).map((key) => LLM_PROVIDERS[key.provider].label)
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRound />
            </EmptyMedia>
            <EmptyTitle>No API keys yet</EmptyTitle>
            <EmptyDescription>
              Add a provider credential to use your own account or API host.
              {serverKeys.length > 0 && ` Until then, reviews use the server's key for ${serverKeys.join(", ")}.`}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{addButton}</EmptyContent>
        </Empty>
        {sheetElement}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ConnectedKeys keys={stored} addButton={addButton} onReplace={openSheet} />
      {sheetElement}
    </div>
  )
}
