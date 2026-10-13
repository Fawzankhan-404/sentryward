import { Loader2 } from "lucide-react"
import { cn } from "cn"

export function FullPageSpinner({ className }: { className?: string }) {
  return (
    <div className={cn("flex min-h-svh items-center justify-center", className)} role="status" aria-label="Loading">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  )
}
