import { lazy, Suspense } from "react"
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ChunkLoadError } from "./ChunkLoadError"
import { ErrorBoundary } from "./ErrorBoundary"
import { reloadPage } from "@/lib/reloadPage"

vi.mock("@/lib/reloadPage", () => ({ reloadPage: vi.fn() }))

const Broken = lazy(() => Promise.reject(new Error("Failed to fetch dynamically imported module")))

describe("ErrorBoundary", () => {
  it("shows a reload action when a lazy chunk fails to load", async () => {
    // React logs the caught error; it is the point of the test.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onError = vi.fn()
    render(
      <ErrorBoundary fallback={<ChunkLoadError />} onError={onError}>
        <Suspense fallback={null}>
          <Broken />
        </Suspense>
      </ErrorBoundary>,
    )

    expect(await screen.findByRole("alert")).toHaveTextContent("This page failed to load")
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Failed to fetch dynamically imported module" }))
    await userEvent.click(screen.getByRole("button", { name: "Reload" }))
    expect(reloadPage).toHaveBeenCalled()
  })
})
