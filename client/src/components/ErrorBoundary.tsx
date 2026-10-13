import { Component, type ErrorInfo, type ReactNode } from "react"

type Props = { children: ReactNode; fallback: ReactNode; onError?: (error: unknown) => void }

// Lazy pages and dialogs throw their rejected import when a chunk fails to
// download; Suspense only covers the pending state, so without this the whole
// tree unmounts. Callers reset it by changing its key.
export class ErrorBoundary extends Component<Props, { error: unknown }> {
  state = { error: null as unknown }

  static getDerivedStateFromError(error: unknown) {
    return { error }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo) {
    this.props.onError?.(error)
  }

  render() {
    return this.state.error ? this.props.fallback : this.props.children
  }
}
