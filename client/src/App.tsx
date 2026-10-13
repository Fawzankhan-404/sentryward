import { lazy, Suspense } from "react"
import { Navigate, Route, Routes, useLocation } from "react-router"
import { ChunkLoadError } from "@/components/ChunkLoadError"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { ProtectedRoute } from "@/features/auth/ProtectedRoute"
import { PublicOnlyRoute } from "@/features/auth/PublicOnlyRoute"
import { FullPageSpinner } from "@/features/auth/FullPageSpinner"
import { DashboardLayout } from "@/layouts/DashboardLayout"

// Pages load on demand to keep the entry chunk small. The guards and the layout
// stay static so they render (and redirect) without waiting on a chunk.
const AdminUsersPage = lazy(() => import("@/pages/admin/AdminUsersPage").then((m) => ({ default: m.AdminUsersPage })))
const ConfigurationPage = lazy(() => import("@/pages/config/ConfigurationPage").then((m) => ({ default: m.ConfigurationPage })))
const FindingsPage = lazy(() => import("@/pages/findings/FindingsPage").then((m) => ({ default: m.FindingsPage })))
const HomePage = lazy(() => import("@/pages/home/HomePage").then((m) => ({ default: m.HomePage })))
const InvitePage = lazy(() => import("@/pages/invite/InvitePage").then((m) => ({ default: m.InvitePage })))
const LlmConnectionsPage = lazy(() => import("@/pages/llm-connections/LlmConnectionsPage").then((m) => ({ default: m.LlmConnectionsPage })))
const LoginPage = lazy(() => import("@/pages/auth/LoginPage").then((m) => ({ default: m.LoginPage })))
const RegisterPage = lazy(() => import("@/pages/auth/RegisterPage").then((m) => ({ default: m.RegisterPage })))
const RepositoriesPage = lazy(() => import("@/pages/forge/RepositoriesPage").then((m) => ({ default: m.RepositoriesPage })))
const ReviewDetailPage = lazy(() => import("@/pages/reviews/ReviewDetailPage").then((m) => ({ default: m.ReviewDetailPage })))
const ReviewsPage = lazy(() => import("@/pages/reviews/ReviewsPage").then((m) => ({ default: m.ReviewsPage })))
const SettingsPage = lazy(() => import("@/pages/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })))
const WorkspacePage = lazy(() => import("@/pages/workspace/WorkspacePage").then((m) => ({ default: m.WorkspacePage })))

// Connections now live on the Repositories page. Keep the old path working for
// bookmarks and GitHub returns already in flight, passing ?connected=/?error= on.
function ConnectionsRedirect() {
  const params = new URLSearchParams(useLocation().search)
  params.set("tab", "installation")
  return <Navigate to={`/repositories?${params}`} replace />
}

export function App() {
  // The outer boundary covers the public pages; DashboardLayout has its own so a
  // failed page there keeps the sidebar.
  return (
    <ErrorBoundary fallback={<ChunkLoadError className="min-h-svh" />}>
      <Suspense fallback={<FullPageSpinner />}>
        <Routes>
          <Route element={<PublicOnlyRoute />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>
          {/* Reachable signed in or out: it explains what to do in either case. */}
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<DashboardLayout />}>
              <Route path="/home" element={<HomePage />} />
              {/* Old bookmarks and links. */}
              <Route path="/dashboard" element={<Navigate to="/home" replace />} />
              <Route path="/reviews" element={<ReviewsPage />} />
              <Route path="/reviews/:id" element={<ReviewDetailPage />} />
              <Route path="/findings" element={<FindingsPage />} />
              <Route path="/repositories" element={<RepositoriesPage />} />
              <Route path="/connections" element={<ConnectionsRedirect />} />
              <Route path="/configuration" element={<ConfigurationPage />} />
              <Route path="/llm-connections" element={<LlmConnectionsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/workspace" element={<WorkspacePage />} />
              <Route path="/admin/users" element={<AdminUsersPage />} />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  )
}
