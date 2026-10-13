import { describe, expect, it, vi } from "vitest"
import { screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { App } from "@/App"
import { mockApi } from "@/test/apiRoutes"
import { renderWithProviders } from "@/test/renderWithProviders"

// Stands in for the dialog's chunk failing to download.
vi.mock("@/features/workspaces/CreateTeamDialog", () => {
  throw new Error("Failed to fetch dynamically imported module")
})

describe("create team dialog", () => {
  it("toasts a reload action when its chunk fails, keeping the sidebar", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    mockApi({ "GET /api/reviews": { reviews: [], total: 0 } })
    renderWithProviders(<App />, { route: "/reviews" })

    await userEvent.click(await screen.findByRole("button", { name: "Switch workspace" }))
    await userEvent.click(await screen.findByRole("menuitem", { name: "Create team" }))

    expect(await screen.findByText("Could not open the create team dialog")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Switch workspace" })).toBeInTheDocument()
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
})
