import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/layout/page-header";
import { SshKeysSection } from "@/components/ssh-keys-section";

export const Route = createFileRoute("/profile")({
  component: ProfilePage,
});

function ProfilePage() {
  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Profile"
        description="Your personal settings and SSH keys"
      />

      <SshKeysSection />
    </div>
  );
}
