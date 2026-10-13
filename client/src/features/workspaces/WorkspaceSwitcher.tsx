import { lazy, Suspense, useState } from "react"
import { useNavigate } from "react-router"
import { Check, ChevronsUpDown, Plus, User, Users } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { useAuth } from "@/features/auth/useAuth"

// The switcher is part of the dashboard shell, so it is in the entry chunk; the
// dialog's form (zod, react-hook-form) loads the first time it is opened.
const CreateTeamDialog = lazy(() => import("./CreateTeamDialog").then((m) => ({ default: m.CreateTeamDialog })))

export function WorkspaceSwitcher() {
  const { workspaces, workspace, switchWorkspace } = useAuth()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  // Stays mounted once loaded so closing still animates.
  const [dialogLoaded, setDialogLoaded] = useState(false)

  if (!workspace) return null
  const Icon = workspace.personal ? User : Users

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Switch workspace"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <img src="/sentryward-192.png" alt="" className="size-8 shrink-0" />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Sentryward</span>
                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  <Icon className="size-3 shrink-0" aria-hidden />
                  {workspace.personal ? "Personal" : workspace.name}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem
                key={w.id}
                onSelect={() => {
                  if (w.id === workspace.id) return
                  switchWorkspace(w.id)
                  navigate("/home")
                }}
              >
                {w.personal ? <User /> : <Users />}
                <span className="truncate">{w.personal ? "Personal" : w.name}</span>
                {w.id === workspace.id && <Check className="ml-auto" aria-label="Current workspace" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setDialogLoaded(true)
                setCreating(true)
              }}
            >
              <Plus />
              Create team
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {dialogLoaded && (
          <Suspense fallback={null}>
            <CreateTeamDialog open={creating} onOpenChange={setCreating} />
          </Suspense>
        )}
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
