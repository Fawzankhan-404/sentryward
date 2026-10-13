import { TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { reloadPage } from "@/lib/reloadPage"

// Fallback for a lazy page whose chunk failed to download.

export function ChunkLoadError({ className }: { className?: string }) {
  return (
    <Empty role="alert" className={className}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlert />
        </EmptyMedia>
        <EmptyTitle>This page failed to load</EmptyTitle>
        <EmptyDescription>Check your connection, or reload to get the latest version of Sentryward.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={reloadPage}>Reload</Button>
      </EmptyContent>
    </Empty>
  )
}
