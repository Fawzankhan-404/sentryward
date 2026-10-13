import { describe, expect, it } from "vitest"
import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { jsonResponse, mockFetch, renderWithProviders } from "@/test/renderWithProviders"

const user = { id: "2", name: "Grace Hopper", email: "grace@example.com", role: "member", avatarUpdatedAt: null, createdAt: "" }

// Signed out, with the given registration mode and invite routes.
function signedOut(routes: Record<string, () => Response>) {
  return mockFetch((url, init) => {
    const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
    return routes[key]?.() ?? jsonResponse(401, { message: "Not authenticated" })
  })
}

const mode = (value: string, firstUser = false) => () => jsonResponse(200, { mode: value, firstUser })

describe("registration modes", () => {
  it("explains that registration is closed instead of showing the form", async () => {
    signedOut({ "GET /api/auth/registration": mode("closed") })
    renderWithProviders(<App />, { route: "/register" })

    expect(await screen.findByText("Registration is closed")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument()
  })

  it("asks for an invite in invite mode when there is no token", async () => {
    signedOut({ "GET /api/auth/registration": mode("invite") })
    renderWithProviders(<App />, { route: "/register" })

    expect(await screen.findByText("Invite required")).toBeInTheDocument()
  })

  it("lets the first user register even when closed, and says they will be admin", async () => {
    signedOut({ "GET /api/auth/registration": mode("closed", true) })
    renderWithProviders(<App />, { route: "/register" })

    expect(await screen.findByText(/you will be this instance's admin/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument()
  })

  it("sends the invite token from the link with the registration", async () => {
    const fetchSpy = signedOut({
      "GET /api/auth/registration": mode("invite"),
      "POST /api/auth/register": () => jsonResponse(201, { user }),
    })
    renderWithProviders(<App />, { route: "/register?invite=tok123" })

    await userEvent.type(await screen.findByLabelText("Name"), user.name)
    await userEvent.type(screen.getByLabelText("Email"), user.email)
    await userEvent.type(screen.getByLabelText("Password"), "supersecret123")
    await userEvent.type(screen.getByLabelText("Confirm password"), "supersecret123")
    await userEvent.click(screen.getByRole("button", { name: "Create account" }))

    await screen.findByRole("heading", { name: "Overview" })
    const register = fetchSpy.mock.calls.find(([url]) => String(url) === "/api/auth/register")
    expect(JSON.parse(String(register?.[1]?.body))).toMatchObject({ inviteToken: "tok123" })
  })
})

describe("login page sign-up link", () => {
  it.each([
    ["open", false],
    ["closed", true],
  ])("is offered in %s mode (first user: %s)", async (value, firstUser) => {
    signedOut({ "GET /api/auth/registration": mode(value, firstUser) })
    renderWithProviders(<App />, { route: "/login" })

    expect(await screen.findByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/register")
  })

  it.each(["closed", "invite"])("is hidden in %s mode", async (value) => {
    const fetchSpy = signedOut({ "GET /api/auth/registration": mode(value) })
    renderWithProviders(<App />, { route: "/login" })

    await screen.findByText("Welcome back")
    await waitFor(() => expect(fetchSpy.mock.calls.some(([url]) => String(url) === "/api/auth/registration")).toBe(true))
    // Let the registration response render before checking the link is absent.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole("link", { name: "Sign up" })).not.toBeInTheDocument()
  })
})

describe("invite page", () => {
  it("shows who invited you and links to registration with the token", async () => {
    signedOut({
      "GET /api/auth/invites/tok123": () =>
        jsonResponse(200, { invite: { email: "grace@example.com", expiresAt: "", invitedBy: { name: "Ada" } } }),
    })
    renderWithProviders(<App />, { route: "/invite/tok123" })

    expect(await screen.findByText("Ada invited you to create an account as grace@example.com.")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register?invite=tok123")
  })

  const teamInvite = {
    invite: { email: null, expiresAt: "", invitedBy: { name: "Ada" }, role: "member", workspace: { name: "Acme" } },
  }
  const acme = { id: "w-team", name: "Acme", personal: false, role: "member" }
  const personal = { id: "w-personal", name: "Grace Hopper", personal: true, role: "owner" }

  it("lets a signed-in user join a team from its invite", async () => {
    const fetchSpy = mockFetch((url, init) => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
      if (key === "GET /api/auth/me") return jsonResponse(200, { user, workspaces: [personal] })
      if (key === "GET /api/auth/invites/team1") return jsonResponse(200, teamInvite)
      if (key === "POST /api/auth/invites/team1/accept") return jsonResponse(201, { workspace: acme })
      if (key === "GET /api/workspaces") return jsonResponse(200, { workspaces: [personal, acme] })
      return jsonResponse(404, { message: `No stub for ${key}` })
    })
    renderWithProviders(<App />, { route: "/invite/team1" })

    expect(await screen.findByText("Ada invited you to join the Acme team.")).toBeInTheDocument()
    await userEvent.click(await screen.findByRole("button", { name: "Join Acme" }))

    expect(await screen.findByRole("button", { name: "Switch workspace" })).toHaveTextContent("Acme")
    expect(fetchSpy.mock.calls.some(([url, init]) => String(url) === "/api/auth/invites/team1/accept" && init?.method === "POST")).toBe(true)
  })

  it("shows why joining failed", async () => {
    mockFetch((url, init) => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
      if (key === "GET /api/auth/me") return jsonResponse(200, { user, workspaces: [personal] })
      if (key === "GET /api/auth/invites/team1") return jsonResponse(200, teamInvite)
      if (key === "POST /api/auth/invites/team1/accept") {
        return jsonResponse(409, { message: "You are already a member of this workspace" })
      }
      return jsonResponse(404, { message: `No stub for ${key}` })
    })
    renderWithProviders(<App />, { route: "/invite/team1" })

    await userEvent.click(await screen.findByRole("button", { name: "Join Acme" }))
    expect(await screen.findByText("You are already a member of this workspace")).toBeInTheDocument()
  })

  it("still asks a signed-in user to log out for an instance invite", async () => {
    mockFetch((url) =>
      url === "/api/auth/me"
        ? jsonResponse(200, { user, workspaces: [personal] })
        : jsonResponse(200, { invite: { email: null, expiresAt: "", invitedBy: null, role: null, workspace: null } }),
    )
    renderWithProviders(<App />, { route: "/invite/inst1" })

    expect(await screen.findByText(/Log out first to create a new account/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Join/ })).not.toBeInTheDocument()
  })

  it("brings a user who logs in back to the team invite", async () => {
    let signedIn = false
    mockFetch((url, init) => {
      const key = `${(init?.method ?? "GET").toUpperCase()} ${url}`
      if (key === "GET /api/auth/me") {
        return signedIn ? jsonResponse(200, { user, workspaces: [personal] }) : jsonResponse(401, { message: "Not authenticated" })
      }
      if (key === "POST /api/auth/login") {
        signedIn = true
        return jsonResponse(200, { user, workspaces: [personal] })
      }
      if (key === "GET /api/auth/invites/team1") return jsonResponse(200, teamInvite)
      return jsonResponse(404, { message: `No stub for ${key}` })
    })
    renderWithProviders(<App />, { route: "/invite/team1" })

    await userEvent.click(await screen.findByRole("link", { name: "Log in" }))
    await userEvent.type(await screen.findByLabelText("Email"), "grace@example.com")
    await userEvent.type(screen.getByLabelText("Password"), "password123")
    await userEvent.click(screen.getByRole("button", { name: "Log in" }))

    expect(await screen.findByRole("button", { name: "Join Acme" })).toBeInTheDocument()
  })

  it("says when an invite is no longer valid", async () => {
    signedOut({ "GET /api/auth/invites/old": () => jsonResponse(404, { message: "Invalid" }) })
    renderWithProviders(<App />, { route: "/invite/old" })

    expect(await screen.findByText("Invite not valid")).toBeInTheDocument()
  })
})
