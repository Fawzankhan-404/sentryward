import { describe, expect, it } from "vitest"
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { fetchReviewMarkdown } from "@/features/reviews/api"
import { setApiWorkspace } from "@/lib/api"
import { jsonResponse, renderWithProviders } from "@/test/renderWithProviders"
import { mockApi, personalWorkspace, teamWorkspace, testUser } from "@/test/apiRoutes"
import { listItem } from "@/test/fixtures"

const header = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.["x-sentryward-workspace"]

const owner = { id: "9", name: "Grace Hopper", email: "grace@example.com", role: "owner", joinedAt: "2026-10-01T00:00:00Z", avatarUpdatedAt: null }
const self = { id: testUser.id, name: testUser.name, email: testUser.email, role: "admin", joinedAt: "2026-10-02T00:00:00Z", avatarUpdatedAt: null }
const plain = { id: "7", name: "Alan Turing", email: "alan@example.com", role: "member", joinedAt: "2026-10-03T00:00:00Z", avatarUpdatedAt: null }

describe("workspace switching", () => {
  it("starts in the personal workspace and sends no workspace header", async () => {
    const fetchSpy = mockApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    renderWithProviders(<App />, { route: "/reviews" })

    expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent("Personal")
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url).startsWith("/api/reviews"))).toBe(true))
    for (const [, init] of fetchSpy.mock.calls) expect(header(init)).toBeUndefined()
  })

  it("refetches the page's data for the team after a switch", async () => {
    const fetchSpy = mockApi({
      "GET /api/reviews": (init?: RequestInit) =>
        jsonResponse(200, header(init) === teamWorkspace.id ? { reviews: [listItem], total: 1 } : { reviews: [], total: 0 }),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Switch workspace" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Acme" }))

    expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent("Acme")
    await waitFor(() =>
      expect(fetchSpy.mock.calls.some(([url, init]) => String(url).startsWith("/api/reviews") && header(init) === teamWorkspace.id)).toBe(
        true,
      ),
    )
    expect(localStorage.getItem("sentryward.workspace")).toBe(teamWorkspace.id)
  })

  it("loads the create team dialog the first time it is opened", async () => {
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Switch workspace" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Create team" }))

    expect(await screen.findByRole("dialog", { name: "Create a team" })).toBeInTheDocument()
  })

  it("restores the remembered workspace and drops one you are no longer in", async () => {
    localStorage.setItem("sentryward.workspace", teamWorkspace.id)
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    const first = renderWithProviders(<App />, { route: "/reviews" })
    expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent("Acme")
    first.unmount()

    localStorage.setItem("sentryward.workspace", "gone")
    renderWithProviders(<App />, { route: "/reviews" })
    expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent("Personal")
  })

  it("falls back to the personal workspace when a team request reports it is gone", async () => {
    // Acting in the team: its data now 404s (removed or deleted) and the list
    // no longer carries it, so the refresh on that error drops back to personal.
    localStorage.setItem("sentryward.workspace", teamWorkspace.id)
    const fetchSpy = mockApi({
      "GET /api/workspaces": { workspaces: [personalWorkspace] },
      "GET /api/reviews": (init?: RequestInit) =>
        header(init) === teamWorkspace.id
          ? jsonResponse(404, { message: "Workspace not found" })
          : jsonResponse(200, { reviews: [], total: 0 }),
    })
    renderWithProviders(<App />, { route: "/reviews" })

    // The button exists immediately showing Acme, so wait for the fallback to land.
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch workspace" })).toHaveTextContent("Personal"))
    expect(
      fetchSpy.mock.calls.some(([url, init]) => String(url).startsWith("/api/reviews") && header(init) === undefined),
    ).toBe(true)
  })

  it("sends the workspace with the markdown download", async () => {
    const fetchSpy = mockApi({ "GET /api/reviews/r1/markdown": () => new Response("# Review") })
    setApiWorkspace(teamWorkspace.id)
    try {
      expect(await fetchReviewMarkdown("r1")).toBe("# Review")
    } finally {
      setApiWorkspace(null)
    }
    expect(header(fetchSpy.mock.calls[0]?.[1])).toBe(teamWorkspace.id)
  })
})

describe("team page", () => {
  function teamApi(routes: Record<string, unknown> = {}) {
    localStorage.setItem("sentryward.workspace", teamWorkspace.id)
    return mockApi({
      "GET /api/workspaces/w-team/members": { members: [owner, self, plain] },
      "GET /api/workspaces/w-team/invites": { invites: [] },
      ...routes,
    })
  }

  it("is not reachable from the personal workspace", async () => {
    mockApi({ "GET /api/connections": { connections: [], availableApps: [] } })
    renderWithProviders(<App />, { route: "/workspace" })

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "Teams" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "User Management" })).not.toBeInTheDocument()
  })

  it("is under User Management for any team member, without the admin-only Users page", async () => {
    teamApi()
    renderWithProviders(<App />, { route: "/workspace" })

    const group = await screen.findByRole("button", { name: "User Management" })
    // An entry of the main navigation, not a group of its own.
    expect(group.closest("[data-sidebar=group]")).toBe(screen.getByRole("link", { name: "Home" }).closest("[data-sidebar=group]"))
    expect(screen.getByRole("link", { name: "Teams" })).toHaveAttribute("href", "/workspace")
    expect(screen.queryByRole("link", { name: "Users" })).not.toBeInTheDocument()
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" })
    expect(within(breadcrumb).getByText("User Management")).toBeInTheDocument()
    expect(within(breadcrumb).getByText("Teams")).toHaveAttribute("aria-current", "page")
  })

  it("lets an admin manage members and admins, but not the owner", async () => {
    teamApi()
    renderWithProviders(<App />, { route: "/workspace" })

    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument()
    expect(await screen.findByRole("combobox", { name: "Role for Alan Turing" })).toBeInTheDocument()
    expect(screen.queryByRole("combobox", { name: "Role for Grace Hopper" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Remove Grace Hopper" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Remove Alan Turing" })).toBeInTheDocument()
    // Settings is for owners only.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Members", "Pending invites"])
  })

  it("shows a plain member only the Members tab, even when another is asked for", async () => {
    localStorage.setItem("sentryward.workspace", teamWorkspace.id)
    mockApi({
      "GET /api/auth/me": { user: testUser, workspaces: [{ ...teamWorkspace, role: "member" }] },
      "GET /api/workspaces/w-team/members": { members: [owner, { ...self, role: "member" }, plain] },
    })
    renderWithProviders(<App />, { route: "/workspace?tab=settings" })

    expect(await screen.findByRole("tab", { name: "Members", selected: true })).toBeInTheDocument()
    expect(screen.getAllByRole("tab")).toHaveLength(1)
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Delete team" })).not.toBeInTheDocument()
  })

  it("creates an invite with a role and shows its link once", async () => {
    const created = {
      invite: { id: "i1", email: null, role: "admin", expiresAt: "", createdAt: "", invitedBy: { name: "Ada" } },
      link: "http://localhost/invite/secret",
      emailed: false,
    }
    const fetchSpy = teamApi({ "POST /api/workspaces/w-team/invites": () => jsonResponse(201, created) })
    renderWithProviders(<App />, { route: "/workspace" })

    await userEvent.click(await screen.findByRole("tab", { name: "Pending invites" }))
    await userEvent.click(await screen.findByRole("button", { name: "Invite" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.click(within(dialog).getByRole("combobox", { name: "Role" }))
    await userEvent.click(await screen.findByRole("option", { name: "Admin" }))
    await userEvent.click(within(dialog).getByRole("button", { name: "Create invite" }))

    expect(await screen.findByLabelText("Invite link")).toHaveValue(created.link)
    const post = fetchSpy.mock.calls.find(([url, init]) => String(url) === "/api/workspaces/w-team/invites" && init?.method === "POST")
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ role: "admin" })
  })

  it("goes back to the personal workspace after leaving", async () => {
    // The session seeds the list on load, so it is fetched only after leaving.
    teamApi({
      "DELETE /api/workspaces/w-team/members/1": () => jsonResponse(204),
      "GET /api/workspaces": { workspaces: [{ id: "w-personal", name: "Ada Lovelace", personal: true, role: "owner" }] },
      "GET /api/connections": { connections: [], availableApps: [] },
    })
    renderWithProviders(<App />, { route: "/workspace" })

    await userEvent.click(await screen.findByRole("button", { name: "Leave" }))
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Leave team" }))

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Switch workspace" })).toHaveTextContent("Personal")
    expect(localStorage.getItem("sentryward.workspace")).toBe("w-personal")
  })

  describe("tables", () => {
    // Member emails in table order, skipping the header row. (The name cell
    // also holds avatar initials, so the email column reads cleaner.)
    const memberEmails = () =>
      screen
        .getAllByRole("row")
        .slice(1)
        .map((row) => within(row).queryAllByRole("cell")[1]?.textContent ?? "")

    it("searches members by name or email, with an empty row when nothing matches", async () => {
      teamApi()
      renderWithProviders(<App />, { route: "/workspace" })

      const search = await screen.findByRole("searchbox", { name: "Search members" })
      await userEvent.type(search, "alan@")
      await waitFor(() => expect(memberEmails()).toEqual(["alan@example.com"]))

      await userEvent.clear(search)
      await userEvent.type(search, "zzz")
      expect(await screen.findByText("No members match your filters.")).toBeInTheDocument()
    })

    it("filters members by role and shows the filter as a removable chip", async () => {
      teamApi()
      renderWithProviders(<App />, { route: "/workspace" })

      await screen.findByText("Alan Turing")
      await userEvent.click(screen.getByRole("button", { name: "Filters" }))
      await userEvent.click(screen.getByRole("combobox", { name: "Role" }))
      await userEvent.click(await screen.findByRole("option", { name: "Owner" }))

      await waitFor(() => expect(memberEmails()).toEqual(["grace@example.com"]))
      await userEvent.click(screen.getByRole("button", { name: "Remove Role filter" }))
      await waitFor(() => expect(memberEmails()).toHaveLength(3))
    })

    it("sorts members by a column header, then reverses", async () => {
      teamApi()
      renderWithProviders(<App />, { route: "/workspace" })

      await screen.findByText("Alan Turing")
      await userEvent.click(screen.getByRole("button", { name: "Name" }))
      expect(memberEmails()).toEqual(["ada@example.com", "alan@example.com", "grace@example.com"])
      await userEvent.click(screen.getByRole("button", { name: "Name" }))
      expect(memberEmails()).toEqual(["grace@example.com", "alan@example.com", "ada@example.com"])
    })

    const kay = { id: "8", name: "Alan Kay", email: "kay@example.com", avatarUpdatedAt: null }

    async function openAddMember() {
      await userEvent.click(await screen.findByRole("button", { name: "Add member" }))
      return screen.findByRole("dialog")
    }

    async function pickUser(dialog: HTMLElement, name: string) {
      const picker = within(dialog).getByRole("combobox", { name: "User" })
      await waitFor(() => expect(picker).toBeEnabled())
      await userEvent.click(picker)
      await userEvent.click(await screen.findByRole("option", { name: new RegExp(name) }))
    }

    it("adds an existing user picked from the list, with a role", async () => {
      const added = { ...plain, ...kay, role: "admin" }
      const fetchSpy = teamApi({
        "GET /api/workspaces/w-team/member-candidates": { users: [kay] },
        "POST /api/workspaces/w-team/members": () => jsonResponse(201, { member: added }),
      })
      renderWithProviders(<App />, { route: "/workspace" })

      const dialog = await openAddMember()
      await pickUser(dialog, "Alan Kay")
      expect(within(dialog).getByRole("combobox", { name: "User" })).toHaveTextContent("kay@example.com")
      await userEvent.click(within(dialog).getByRole("combobox", { name: "Role" }))
      await userEvent.click(await screen.findByRole("option", { name: "Admin" }))
      await userEvent.click(within(dialog).getByRole("button", { name: "Add member" }))

      expect(await screen.findByText("Alan Kay was added")).toBeInTheDocument()
      const post = fetchSpy.mock.calls.find(([url, init]) => String(url) === "/api/workspaces/w-team/members" && init?.method === "POST")
      expect(JSON.parse(String(post?.[1]?.body))).toEqual({ email: "kay@example.com", role: "admin" })
    })

    it("asks for a user before adding, and shows the server's reason it failed", async () => {
      const fetchSpy = teamApi({
        "GET /api/workspaces/w-team/member-candidates": { users: [kay] },
        "POST /api/workspaces/w-team/members": () =>
          jsonResponse(409, { message: "Validation failed", errors: { email: ["This person is already a member"] } }),
      })
      renderWithProviders(<App />, { route: "/workspace" })

      const dialog = await openAddMember()
      await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "User" })).toBeEnabled())
      await userEvent.click(within(dialog).getByRole("button", { name: "Add member" }))
      expect(await within(dialog).findByText("Choose a user")).toBeInTheDocument()
      expect(fetchSpy.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false)

      await pickUser(dialog, "Alan Kay")
      await userEvent.click(within(dialog).getByRole("button", { name: "Add member" }))
      expect(await within(dialog).findByText("This person is already a member")).toBeInTheDocument()
    })

    it("says when everyone is already in the team", async () => {
      teamApi({ "GET /api/workspaces/w-team/member-candidates": { users: [] } })
      renderWithProviders(<App />, { route: "/workspace" })

      const dialog = await openAddMember()
      const picker = within(dialog).getByRole("combobox", { name: "User" })
      await waitFor(() => expect(picker).toBeEnabled())
      await userEvent.click(picker)

      expect(await screen.findByText(/No one else to add/)).toBeInTheDocument()
    })

    it("pages through a long member list", async () => {
      const extra = Array.from({ length: 9 }, (_, i) => ({ ...plain, id: `x${i}`, name: `Extra ${i}`, email: `x${i}@example.com` }))
      teamApi({ "GET /api/workspaces/w-team/members": { members: [owner, self, plain, ...extra] } })
      renderWithProviders(<App />, { route: "/workspace" })

      await screen.findByText("Showing 1-10 of 12")
      expect(memberEmails()).toHaveLength(10)
      await userEvent.click(screen.getByRole("button", { name: "Next page" }))
      await waitFor(() => expect(memberEmails()).toEqual(["x7@example.com", "x8@example.com"]))
    })

    it("explains an empty invite list", async () => {
      teamApi()
      renderWithProviders(<App />, { route: "/workspace?tab=invites" })

      expect(await screen.findByText(/No pending invites yet/)).toBeInTheDocument()
    })

    const invite = (id: string, email: string | null, role: string) => ({
      id,
      email,
      role,
      expiresAt: "2026-10-13T00:00:00Z",
      createdAt: "2026-10-06T00:00:00Z",
      invitedBy: { name: "Ada" },
    })

    it("resends an email invite from its actions menu", async () => {
      const fetchSpy = teamApi({
        "GET /api/workspaces/w-team/invites": { invites: [invite("i1", "kay@example.com", "admin")] },
        "POST /api/workspaces/w-team/invites/i1/resend": { invite: invite("i1", "kay@example.com", "admin") },
      })
      renderWithProviders(<App />, { route: "/workspace?tab=invites" })

      await userEvent.click(await screen.findByRole("button", { name: "Actions for kay@example.com" }))
      await userEvent.click(await screen.findByRole("menuitem", { name: "Resend email" }))
      const dialog = await screen.findByRole("dialog")
      expect(dialog).toHaveTextContent("a new link to join Acme to kay@example.com")
      await userEvent.click(within(dialog).getByRole("button", { name: "Send email" }))

      expect(await screen.findByText("Invite sent to kay@example.com")).toBeInTheDocument()
      expect(
        fetchSpy.mock.calls.some(
          ([url, init]) => String(url) === "/api/workspaces/w-team/invites/i1/resend" && init?.method === "POST",
        ),
      ).toBe(true)
    })

    it("revokes an open link from its actions menu, which cannot be resent", async () => {
      const fetchSpy = teamApi({
        "GET /api/workspaces/w-team/invites": { invites: [invite("i2", null, "member")] },
        "DELETE /api/workspaces/w-team/invites/i2": () => jsonResponse(204),
      })
      renderWithProviders(<App />, { route: "/workspace?tab=invites" })

      await userEvent.click(await screen.findByRole("button", { name: "Actions for open invite link" }))
      expect(screen.queryByRole("menuitem", { name: "Resend email" })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole("menuitem", { name: "Revoke" }))
      await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Revoke invite" }))

      expect(await screen.findByText("Invite revoked")).toBeInTheDocument()
      expect(
        fetchSpy.mock.calls.some(([url, init]) => String(url) === "/api/workspaces/w-team/invites/i2" && init?.method === "DELETE"),
      ).toBe(true)
    })

    it("filters invites by type and searches them", async () => {
      teamApi({
        "GET /api/workspaces/w-team/invites": {
          invites: [invite("i1", "kay@example.com", "admin"), invite("i2", null, "member"), invite("i3", "lin@example.com", "member")],
        },
      })
      renderWithProviders(<App />, { route: "/workspace?tab=invites" })

      await screen.findByText("kay@example.com")
      await userEvent.click(screen.getByRole("button", { name: "Filters" }))
      await userEvent.click(screen.getByRole("combobox", { name: "Type" }))
      await userEvent.click(await screen.findByRole("option", { name: "Specific email" }))
      await waitFor(() => expect(screen.queryByRole("cell", { name: "Anyone with the link" })).not.toBeInTheDocument())

      await userEvent.type(screen.getByRole("searchbox", { name: "Search invites" }), "lin")
      await waitFor(() => expect(screen.queryByText("kay@example.com")).not.toBeInTheDocument())
      expect(screen.getByText("lin@example.com")).toBeInTheDocument()
    })
  })
})
