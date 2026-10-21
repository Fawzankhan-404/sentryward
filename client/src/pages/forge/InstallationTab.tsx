import { useEffect, useMemo, useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Link, useSearchParams } from "react-router"
import { FolderGit2, Info, Loader2, MoreHorizontal, Plug, Plus, Trash2 } from "lucide-react"
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Checkbox } from "@/components/ui/checkbox"
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
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import {
  statusRank,
  STATUS_OPTIONS,
  useConnectionStatuses,
  useConnectToken,
  useConnections,
  useDeleteConnection,
  type Connection,
  type ConnectionStatus,
  type TokenConnectInput,
} from "@/features/forge/api"
import { FORGE_KIND_OPTIONS, forgeKey, kindLabel } from "@/features/forge/forgeKind"
import { ConnectionDetailsSheet } from "@/features/forge/ConnectionDetailsSheet"
import { ConnectionStatusBadge } from "@/features/forge/ConnectionStatusBadge"
import { isProvider, offersOAuth, PROVIDER_IDS, PROVIDERS, type TokenMethod } from "@/features/forge/providers"
import type { Provider } from "@/features/reviews/types"
import { apiWorkspace } from "@/lib/api"

// The install (or OAuth sign-in) starts with a browser navigation, which cannot carry the
// workspace header, so a team workspace goes in the query instead.
function installHref(href: string) {
  const workspace = apiWorkspace()
  return workspace ? `${href}?${new URLSearchParams({ workspace })}` : href
}

function tokenSchema(method: TokenMethod) {
  const shape: Record<string, z.ZodString> = {
    host: method.fixedHost ? z.string().trim() : z.string().trim().min(1, "Host is required"),
    token: z.string().trim().min(1, "Token is required"),
  }
  for (const field of method.extraFields ?? []) {
    shape[field.name] = z.string().trim().min(1, `${field.label} is required`)
  }
  return z.object(shape)
}

const RETURN_MESSAGES: Record<string, string> = {
  github_install_failed: "GitHub installation could not be completed",
  github_install_forbidden: "That GitHub installation is not one your account can access",
  github_pending_approval: "The installation is waiting for an organization owner to approve it",
  gitlab_oauth_failed: "GitLab sign-in could not be completed",
  gitlab_oauth_denied: "GitLab sign-in was cancelled",
}

// GitHub and GitLab send the browser back here with ?connected= or ?error=.
function useReturnToast() {
  const [params, setParams] = useSearchParams()
  useEffect(() => {
    const connected = params.get("connected")
    const error = params.get("error")
    if (!connected && !error) return
    if (connected) toast.success(`${isProvider(connected) ? PROVIDERS[connected].label : "Account"} connected`)
    if (error) toast.error(RETURN_MESSAGES[error] ?? "Connection failed")
    // Drop only the return markers so ?tab= survives.
    const next = new URLSearchParams(params)
    next.delete("connected")
    next.delete("error")
    setParams(next, { replace: true })
  }, [params, setParams])
}

function TokenForm({
  provider,
  method,
  onConnected,
}: {
  provider: Provider
  method: TokenMethod
  onConnected?: () => void
}) {
  const connect = useConnectToken(provider)
  const label = PROVIDERS[provider].label
  const extraFields = method.extraFields ?? []
  const form = useForm<TokenConnectInput>({
    resolver: zodResolver(tokenSchema(method)),
    defaultValues: {
      host: method.fixedHost ?? "",
      token: "",
      ...Object.fromEntries(extraFields.map((field) => [field.name, ""])),
    },
  })

  async function onSubmit(values: TokenConnectInput) {
    try {
      const { connection } = await connect.mutateAsync(values)
      toast.success(`Connected ${label} as ${connection.accountLogin}`)
      form.reset({ ...values, token: "" })
      onConnected?.()
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {!method.fixedHost && (
          <TextField control={form.control} name="host" label="Host" placeholder={method.hostPlaceholder} />
        )}
        {extraFields.map((field) => (
          <TextField
            key={field.name}
            control={form.control}
            name={field.name}
            label={field.label}
            type={field.type ?? "text"}
            autoComplete="off"
            placeholder={field.placeholder}
          />
        ))}
        <TextField
          control={form.control}
          name="token"
          label="Access token"
          type="password"
          autoComplete="off"
          placeholder={method.tokenPlaceholder}
        />
        <Field>
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Connect {label}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

type SortKey = "account" | "forge" | "host" | "repositories" | "active" | "addedBy" | "createdAt"

function compareConnections(
  a: Connection,
  b: Connection,
  key: SortKey,
  statuses: Record<string, ConnectionStatus | undefined>,
) {
  switch (key) {
    case "account":
      return a.accountLogin.localeCompare(b.accountLogin)
    case "forge":
      return kindLabel(a).localeCompare(kindLabel(b))
    case "host":
      return a.host.localeCompare(b.host)
    case "repositories":
      return a.repositoryCount - b.repositoryCount
    case "active":
      return statusRank(statuses[a.id]) - statusRank(statuses[b.id])
    case "addedBy":
      return (a.createdBy?.name ?? "").localeCompare(b.createdBy?.name ?? "")
    case "createdAt":
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
  }
}

function formatDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" })
}

function ConnectionsTable({
  connections,
  statuses,
}: {
  connections: Connection[]
  statuses: Record<string, ConnectionStatus | undefined>
}) {
  // Unsorted keeps the API order (oldest first).
  const { sort, onSort } = useSort<SortKey>()
  const [selected, setSelected] = useState<Connection | null>(null)
  const [removing, setRemoving] = useState<Connection | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return connections
    const direction = sort.dir === "asc" ? 1 : -1
    return [...connections].sort(
      (a, b) =>
        direction * compareConnections(a, b, sort.key, statuses) || a.accountLogin.localeCompare(b.accountLogin),
    )
  }, [connections, sort, statuses])
  const pagination = usePagination()
  const page = paginate(sorted, pagination.page, pagination.size)

  const head = { sort, onSort }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Account" sortKey="account" {...head} />
            <SortableHead label="Forge" sortKey="forge" {...head} />
            <SortableHead label="Host" sortKey="host" {...head} />
            <SortableHead label="Repositories" sortKey="repositories" {...head} />
            <SortableHead label="Active" sortKey="active" {...head} />
            <SortableHead label="Added by" sortKey="addedBy" {...head} />
            <SortableHead label="Created" sortKey="createdAt" {...head} />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={8}>No connections match your filters.</NoMatchesRow>}
          {page.rows.map((connection) => {
            const provider = PROVIDERS[connection.provider]
            return (
              <TableRow key={connection.id}>
                <TableCell className="font-medium">{connection.accountLogin}</TableCell>
                <TableCell>
                  <Badge variant="outline">
                    <provider.icon />
                    {kindLabel(connection)}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{connection.host}</TableCell>
                <TableCell className="text-muted-foreground tabular-nums">{connection.repositoryCount}</TableCell>
                <TableCell>
                  <ConnectionStatusBadge status={statuses[connection.id]} />
                </TableCell>
                <TableCell className="text-muted-foreground" title={connection.createdBy?.email}>
                  {connection.createdBy?.name ?? "Removed user"}
                </TableCell>
                <TableCell className="text-muted-foreground" title={new Date(connection.createdAt).toLocaleString()}>
                  {formatDate(connection.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <ConnectionActions
                    connection={connection}
                    onDetails={() => setSelected(connection)}
                    onRemove={() => setRemoving(connection)}
                  />
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
      <ConnectionDetailsSheet connection={selected} onOpenChange={(open) => !open && setSelected(null)} />
      <RemoveConnectionDialog connection={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

function ConnectionActions({
  connection,
  onDetails,
  onRemove,
}: {
  connection: Connection
  onDetails: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${connection.accountLogin}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onDetails}>
          <Info />
          Details
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to={`/repositories?tab=repositories&account=${connection.id}`}>
            <FolderGit2 />
            Manage repositories
          </Link>
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

// The search and filters sit above the card, so their state lives here and
// the table only sorts what it is given.
function ConnectedAccounts({ connections, onAdd }: { connections: Connection[]; onAdd: () => void }) {
  const statuses = useConnectionStatuses(connections)
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [forge, setForge] = useState(ALL)
  const [status, setStatus] = useState(ALL)
  const filtering = forge !== ALL || status !== ALL

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  function clearFilters() {
    setForge(ALL)
    setStatus(ALL)
    setPage(1)
  }

  const filtered = useMemo(
    () =>
      connections.filter(
        (connection) =>
          matchesQuery(
            query,
            connection.accountLogin,
            connection.host,
            connection.createdBy?.name ?? "",
            connection.createdBy?.email ?? "",
          ) &&
          (forge === ALL || forgeKey(connection) === forge) &&
          // Connections still being checked match no specific status.
          (status === ALL || statuses[connection.id] === status),
      ),
    [connections, query, forge, status, statuses],
  )

  const activeFilters = [
    { label: "Forge", value: selectedLabel(forge, FORGE_KIND_OPTIONS), onRemove: () => filterBy(setForge)(ALL) },
    { label: "Status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => filterBy(setStatus)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add connection
        </Button>
        <FilterPopover active={filtering} onClear={clearFilters}>
          <FilterSelect
            id="connection-forge"
            label="Forge"
            allLabel="All forges"
            value={forge}
            onValueChange={filterBy(setForge)}
            options={FORGE_KIND_OPTIONS}
          />
          <FilterSelect
            id="connection-status"
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
          <CardTitle>Connected accounts</CardTitle>
        </CardHeader>
        <CardContent>
          <ConnectionsTable connections={filtered} statuses={statuses} />
        </CardContent>
      </Card>
    </>
  )
}

// Rendered once beside the table rather than inside the row menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
function RemoveConnectionDialog({
  connection,
  onOpenChange,
}: {
  connection: Connection | null
  onOpenChange: (open: boolean) => void
}) {
  const remove = useDeleteConnection()

  async function onRemove() {
    if (!connection) return
    try {
      await remove.mutateAsync(connection.id)
      onOpenChange(false)
      toast.success("Connection removed")
    } catch {
      toast.error("Could not remove the connection")
    }
  }

  return (
    <Dialog open={connection !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {connection && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {connection.accountLogin}?</DialogTitle>
              <DialogDescription>
                Sentryward will stop reviewing its repositories and remove their webhooks. Their review history is deleted
                too. This cannot be undone.
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

function AddConnectionSheet({
  open,
  onOpenChange,
  availableApps,
  oauthHosts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  availableApps: Provider[]
  oauthHosts: Partial<Record<Provider, string>>
}) {
  const [providerId, setProviderId] = useState<Provider>(PROVIDER_IDS[0]!)
  const [selfHosted, setSelfHosted] = useState(false)

  const provider = PROVIDERS[providerId]
  // The checkbox stays ticked across providers; one without a self-hosted
  // option falls back to its cloud one.
  const hosting = (selfHosted && provider.hosting.selfHosted) || provider.hosting.cloud
  const method = hosting.method
  const oauthHost = oauthHosts[providerId]
  const oauth =
    method.type === "token" && availableApps.includes(providerId) && offersOAuth(provider, method, oauthHost)
      ? method.oauth
      : undefined

  function handleOpenChange(next: boolean) {
    if (!next) {
      setProviderId(PROVIDER_IDS[0]!)
      setSelfHosted(false)
    }
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent className="overflow-y-auto data-[side=right]:sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Add connection</SheetTitle>
          <SheetDescription>Connect a code host to choose repositories to review.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="provider">Provider</FieldLabel>
              <SearchableSelect
                id="provider"
                value={providerId}
                onValueChange={(value) => setProviderId(value as Provider)}
                searchPlaceholder="Search providers..."
                options={PROVIDER_IDS.map((id) => ({ value: id, label: PROVIDERS[id].label, icon: PROVIDERS[id].icon }))}
              />
            </Field>
            {provider.hosting.selfHosted && (
              <Field orientation="horizontal">
                <Checkbox
                  id="self-hosted"
                  checked={selfHosted}
                  onCheckedChange={(checked) => setSelfHosted(checked === true)}
                />
                <FieldLabel htmlFor="self-hosted">Self-hosted</FieldLabel>
              </Field>
            )}
          </FieldGroup>
          <Separator />
          <section className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">{hosting.hint}</p>
            {method.type === "app" ? (
              availableApps.includes(providerId) ? (
                <Button asChild>
                  <a href={installHref(method.installHref)}>Install {method.name}</a>
                </Button>
              ) : (
                <p className="text-sm text-muted-foreground">The {method.name} is not configured on this server.</p>
              )
            ) : (
              <>
                {oauth && (
                  <>
                    <Button asChild>
                      <a href={installHref(oauth.startHref)}>Connect with {oauth.name}</a>
                    </Button>
                    <p className="text-sm text-muted-foreground">
                      Signs in on {oauthHost}; comments are posted as the account that signs in. Or paste an access
                      token instead:
                    </p>
                  </>
                )}
                <TokenForm
                  key={`${providerId}-${hosting === provider.hosting.selfHosted}`}
                  provider={providerId}
                  method={method}
                  onConnected={() => handleOpenChange(false)}
                />
              </>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function InstallationTab() {
  useReturnToast()
  const { data, isPending } = useConnections()
  const [adding, setAdding] = useState(false)

  const sheet = (
    <AddConnectionSheet
      open={adding}
      onOpenChange={setAdding}
      availableApps={data?.availableApps ?? []}
      oauthHosts={data?.oauthHosts ?? {}}
    />
  )

  if (isPending) return null

  if (!data?.connections.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Plug />
            </EmptyMedia>
            <EmptyTitle>No connections yet</EmptyTitle>
            <EmptyDescription>Connect GitHub or GitLab to start reviewing.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add connection
            </Button>
          </EmptyContent>
        </Empty>
        {sheet}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <ConnectedAccounts connections={data.connections} onAdd={() => setAdding(true)} />
      {sheet}
    </div>
  )
}
