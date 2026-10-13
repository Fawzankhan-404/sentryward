import { Suspense } from "react"
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router"
import {
  Bug,
  ChevronRight,
  ChevronsUpDown,
  FolderGit2,
  GitPullRequest,
  House,
  KeyRound,
  LogOut,
  Settings,
  SlidersHorizontal,
  UserCog,
  Users,
  UsersRound,
} from "lucide-react"
import { toast } from "sonner"
import { DensityToggle } from "@/components/density-toggle"
import { ModeToggle } from "@/components/mode-toggle"
import { UserAvatar } from "@/components/UserAvatar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
import { FullPageSpinner } from "@/features/auth/FullPageSpinner"
import { useAuth } from "@/features/auth/useAuth"
import { WorkspaceSwitcher } from "@/features/workspaces/WorkspaceSwitcher"

const NAV = [
  { to: "/home", label: "Home", icon: House },
  { to: "/reviews", label: "Reviews", icon: GitPullRequest },
  { to: "/findings", label: "Findings", icon: Bug },
  { to: "/repositories", label: "Repositories", icon: FolderGit2 },
  { to: "/configuration", label: "Configuration", icon: SlidersHorizontal },
  { to: "/llm-connections", label: "LLM Connections", icon: KeyRound },
]

type NavGroupDef = { label: string; icon: typeof House; items: typeof NAV }

// Each item has its own audience (see userManagementItems); the API enforces
// the same rules.
const USER_MANAGEMENT_NAV: NavGroupDef = {
  label: "User Management",
  icon: UserCog,
  items: [
    { to: "/admin/users", label: "Users", icon: Users },
    { to: "/workspace", label: "Teams", icon: UsersRound },
  ],
}

// Users is for instance admins; Teams manages the current team, so it only
// exists in a team workspace (a personal one has no members).
function userManagementItems(isAdmin: boolean, inTeam: boolean) {
  return USER_MANAGEMENT_NAV.items.filter((item) => (item.to === "/admin/users" ? isAdmin : inTeam))
}

// Where you are, for the top bar; each page renders its own h1.
function breadcrumb(pathname: string): { label: string; to?: string }[] {
  if (pathname.startsWith("/reviews/")) return [{ label: "Reviews", to: "/reviews" }, { label: "Review" }]
  if (pathname.startsWith("/settings")) return [{ label: "Settings" }]
  const managed = USER_MANAGEMENT_NAV.items.find((item) => pathname.startsWith(item.to))
  // The group has no page of its own, so it is plain text rather than a link.
  if (managed) return [{ label: USER_MANAGEMENT_NAV.label }, { label: managed.label }]
  return [{ label: NAV.find((item) => pathname.startsWith(item.to))?.label ?? "Home" }]
}

function NavItems({ items, pathname }: { items: typeof NAV; pathname: string }) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.to}>
          <SidebarMenuButton asChild isActive={pathname.startsWith(item.to)} tooltip={item.label}>
            <NavLink to={item.to}>
              <item.icon />
              <span>{item.label}</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  )
}

// Starts open on one of its pages. Collapsed to icons the sidebar hides
// sub-items, so the parent carries the active highlight instead.
function NavGroup({ group, pathname }: { group: NavGroupDef; pathname: string }) {
  const { state } = useSidebar()
  const active = group.items.some((item) => pathname.startsWith(item.to))
  return (
    <SidebarMenu>
      <Collapsible asChild defaultOpen={active} className="group/collapsible">
        <SidebarMenuItem>
          <CollapsibleTrigger asChild>
            <SidebarMenuButton tooltip={group.label} isActive={active && state === "collapsed"}>
              <group.icon />
              <span>{group.label}</span>
              <ChevronRight className="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
            </SidebarMenuButton>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {group.items.map((item) => (
                <SidebarMenuSubItem key={item.to}>
                  <SidebarMenuSubButton asChild isActive={pathname.startsWith(item.to)}>
                    <NavLink to={item.to}>
                      <item.icon />
                      <span>{item.label}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              ))}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    </SidebarMenu>
  )
}

export function DashboardLayout() {
  const { user, workspace, logout } = useAuth()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  async function handleLogout() {
    try {
      await logout()
      navigate("/login", { replace: true })
    } catch {
      toast.error("Could not log out, please try again")
    }
  }

  if (!user) {
    return null
  }
  const managementItems = userManagementItems(user.role === "admin", workspace !== null && !workspace.personal)

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <WorkspaceSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <NavItems items={NAV} pathname={pathname} />
            {managementItems.length > 0 && (
              <NavGroup group={{ ...USER_MANAGEMENT_NAV, items: managementItems }} pathname={pathname} />
            )}
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  >
                    <UserAvatar user={user} className="size-8 rounded-lg after:rounded-lg" fallbackClassName="rounded-lg" />
                    <div className="grid flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{user.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                    </div>
                    <ChevronsUpDown className="ml-auto size-4" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="min-w-56">
                  <DropdownMenuLabel className="font-normal">
                    <div className="grid text-sm leading-tight">
                      <span className="truncate font-medium">{user.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{user.email}</span>
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings">
                      <Settings />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={handleLogout}>
                    <LogOut />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      {/* min-w-0 lets wide content (code blocks, tables) scroll inside the
          page instead of stretching the whole layout past the viewport. */}
      <SidebarInset className="min-w-0 bg-dots">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80 lg:px-6">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <nav aria-label="Breadcrumb" className="min-w-0">
            <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {breadcrumb(pathname).map((crumb, i) => (
                <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
                  {i > 0 && <ChevronRight className="size-3.5 shrink-0" aria-hidden />}
                  {crumb.to ? (
                    <Link to={crumb.to} className="transition-colors hover:text-foreground">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current="page" className="truncate font-medium text-foreground">
                      {crumb.label}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </nav>
          <div className="ml-auto flex items-center gap-1">
            <DensityToggle />
            <ModeToggle />
          </div>
        </header>
        {/* Pages are lazy (see App.tsx); a boundary here keeps the sidebar and
            top bar up while a page's chunk loads. Remounting on a switch resets
            page state along with the cleared cache. */}
        <Suspense fallback={<FullPageSpinner className="min-h-0 flex-1 py-24" />}>
          <Outlet key={workspace?.id} />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
