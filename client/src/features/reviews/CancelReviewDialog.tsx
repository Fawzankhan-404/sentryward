import { Loader2, OctagonX } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { changeLabel, changeTitle } from "./links"
import type { ReviewListItem } from "./types"

// A cancelled review cannot be resumed, only run again from the start, so the
// button asks first.
export function CancelReviewDialog({
  review,
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  review: ReviewListItem
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
  pending: boolean
}) {
  const { provider, fullPath } = review.repository
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel review of {changeTitle(review)}?</DialogTitle>
          <DialogDescription>
            {review.status === "running"
              ? `Sentryward will stop reviewing ${fullPath} ${changeLabel(provider, review.number)} within a few seconds and post nothing more to it.`
              : `The queued review of ${fullPath} ${changeLabel(provider, review.number)} will not run.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Keep running
            </Button>
          </DialogClose>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <OctagonX />}
            Cancel review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
