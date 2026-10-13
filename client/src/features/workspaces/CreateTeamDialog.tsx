import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { useNavigate } from "react-router"
import { Loader2 } from "lucide-react"
import { z } from "zod"
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
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { TextField } from "@/features/auth/TextField"
import { useAuth } from "@/features/auth/useAuth"
import { useCreateWorkspace } from "./api"

const nameSchema = z.object({ name: z.string().trim().min(1, "Name is required").max(100) })
type NameInput = z.infer<typeof nameSchema>

export function CreateTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { switchWorkspace } = useAuth()
  const navigate = useNavigate()
  const create = useCreateWorkspace()
  const form = useForm<NameInput>({ resolver: zodResolver(nameSchema), defaultValues: { name: "" } })

  async function onSubmit({ name }: NameInput) {
    try {
      const workspace = await create.mutateAsync(name)
      onOpenChange(false)
      form.reset()
      switchWorkspace(workspace.id)
      navigate("/workspace")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) form.reset()
      }}
    >
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Create a team</DialogTitle>
            <DialogDescription>
              A team has its own connections, repositories, reviews and keys, shared with the people you invite.
            </DialogDescription>
          </DialogHeader>
          <TextField control={form.control} name="name" label="Name" autoComplete="off" placeholder="Acme" />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Create team
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
