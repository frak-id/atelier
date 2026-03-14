import { useForm, useStore } from "@tanstack/react-form";
import { toast } from "sonner";
import { useCreateOrganization } from "@/api/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface CreateOrganizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateOrganizationDialog({
  open,
  onOpenChange,
}: CreateOrganizationDialogProps) {
  const createMutation = useCreateOrganization();

  const form = useForm({
    defaultValues: {
      name: "",
      slug: "",
    },
    onSubmit: async ({ value }) => {
      createMutation.mutate(
        {
          name: value.name,
          slug: value.slug,
        },
        {
          onSuccess: () => {
            toast.success("Organization created successfully");
            onOpenChange(false);
            form.reset();
          },
          onError: (error) => {
            toast.error(error.message || "Failed to create organization");
          },
        },
      );
    },
  });

  const name = useStore(form.store, (s) => s.values.name);
  const slug = useStore(form.store, (s) => s.values.slug);

  const handleNameChange = (newName: string) => {
    form.setFieldValue("name", newName);
    // Auto-generate slug if it hasn't been manually edited
    // or if it matches the previous auto-generated slug
    const generatedSlug = newName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    form.setFieldValue("slug", generatedSlug);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            form.handleSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create Organization</DialogTitle>
            <DialogDescription>
              Create a new organization to collaborate with your team.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Acme Corp"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="slug">Slug</Label>
              <Input
                id="slug"
                value={slug}
                onChange={(e) => form.setFieldValue("slug", e.target.value)}
                placeholder="acme-corp"
              />
              <p className="text-[0.8rem] text-muted-foreground">
                This will be used in URLs. Only lowercase letters, numbers, and
                hyphens.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  disabled={
                    isSubmitting || createMutation.isPending || !name || !slug
                  }
                >
                  {isSubmitting || createMutation.isPending
                    ? "Creating..."
                    : "Create"}
                </Button>
              )}
            </form.Subscribe>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
