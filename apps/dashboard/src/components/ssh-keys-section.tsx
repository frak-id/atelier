import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Key,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import type { SshKey } from "@/api/client";
import {
  sshKeysListQuery,
  useCreateSshKey,
  useDeleteSshKey,
} from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  generateEd25519Keypair,
  isWebCryptoEd25519Supported,
} from "@/lib/ssh-keygen";
import { getSshKeyExpirationStatus } from "@/lib/utils";

function ExpirationBadge({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) {
    return null;
  }

  const status = getSshKeyExpirationStatus(expiresAt);

  if (status.status === "expired") {
    return (
      <span className="text-xs text-destructive px-2 py-1 bg-destructive/10 rounded">
        Expired
      </span>
    );
  }

  if (status.status === "expiring_soon") {
    const dayText = status.daysRemaining === 1 ? "day" : "days";
    return (
      <span className="text-xs text-amber-500 px-2 py-1 bg-amber-500/10 rounded">
        Expires in {status.daysRemaining} {dayText}
      </span>
    );
  }

  if (status.status === "valid") {
    return (
      <span className="text-xs text-muted-foreground">
        Expires in {status.daysRemaining} days
      </span>
    );
  }

  return null;
}

import { config } from "@/config";

export const SSH_KEY_PATH = "~/.config/oc-sandbox/sandbox_key";
export const SSH_HOST_ALIAS = "atelier";

export function SshKeysSection() {
  const { data: keys, isLoading } = useQuery(sshKeysListQuery);
  const deleteMutation = useDeleteSshKey();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [setupDialogKey, setSetupDialogKey] = useState<SshKey | null>(null);

  if (isLoading) {
    return <div className="animate-pulse h-32 bg-muted rounded" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">SSH Keys</h2>
          <p className="text-sm text-muted-foreground">
            Manage SSH keys for accessing sandboxes remotely
          </p>
        </div>
        <Button onClick={() => setAddDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add SSH Key
        </Button>
      </div>

      {(!keys || keys.length === 0) && (
        <Card className="border-yellow-500/50 bg-yellow-500/10">
          <CardContent className="py-4 flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-yellow-500">
                No SSH Keys Configured
              </p>
              <p className="text-sm text-muted-foreground">
                Add an SSH key to connect to your sandboxes via SSH. You can
                generate a temporary key or upload your existing public key.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {keys?.map((key: SshKey) => (
          <Card
            key={key.id}
            className="cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => setSetupDialogKey(key)}
          >
            <CardHeader className="flex flex-row items-center justify-between py-3">
              <div className="flex items-center gap-3">
                <Key className="h-4 w-4 text-muted-foreground" />
                <div>
                  <CardTitle className="text-sm font-medium">
                    {key.name}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground font-mono">
                    {key.fingerprint}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
                  {key.type === "generated" ? "Generated" : "Uploaded"}
                </span>
                <ExpirationBadge expiresAt={key.expiresAt} />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Delete SSH key "${key.name}"?`)) {
                      deleteMutation.mutate(key.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </div>
            </CardHeader>
          </Card>
        ))}
      </div>

      <AddSshKeyDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onSuccess={() => setAddDialogOpen(false)}
      />

      <SshKeySetupDialog
        sshKey={setupDialogKey}
        onOpenChange={(open) => !open && setSetupDialogKey(null)}
      />
    </div>
  );
}

function useCopyWithFeedback() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  return { copy, isCopied: (key: string) => copiedKey === key };
}

function getSshConfigSnippet() {
  return `
Host ${SSH_HOST_ALIAS}
    HostName ${config.sshHostname}
    Port ${config.sshPort}
    IdentityFile ${SSH_KEY_PATH}
    StrictHostKeyChecking no`;
}

function SetupInstructions({
  privateKey,
  showPrivateKeySetup = true,
}: {
  privateKey?: string;
  showPrivateKeySetup?: boolean;
}) {
  const { copy, isCopied } = useCopyWithFeedback();

  const keySetupCommand = privateKey
    ? `mkdir -p ~/.config/oc-sandbox && cat > ${SSH_KEY_PATH} << 'EOF'
${privateKey}
EOF
chmod 600 ${SSH_KEY_PATH}`
    : null;

  const sshConfigCommand = `grep -q "Host ${SSH_HOST_ALIAS}" ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config << 'EOF'
${getSshConfigSnippet()}
EOF`;

  const fullSetupCommand =
    keySetupCommand && showPrivateKeySetup
      ? `${keySetupCommand}

# Add SSH config for VSCode Remote
${sshConfigCommand}`
      : sshConfigCommand;

  return (
    <Card className="border-blue-500/30 bg-blue-500/5">
      <CardContent className="py-3 space-y-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-blue-500" />
          <p className="text-sm font-medium text-blue-500">
            {showPrivateKeySetup && privateKey
              ? "Quick Setup"
              : "SSH Config Setup"}
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          {showPrivateKeySetup && privateKey
            ? "Run this command to save your key and configure SSH:"
            : "Run this command to add SSH config for VSCode Remote:"}
        </p>
        <div className="relative">
          <pre className="text-xs font-mono bg-muted p-3 rounded overflow-x-auto whitespace-pre-wrap break-all">
            {fullSetupCommand}
          </pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-1 right-1 h-7 w-7"
            onClick={() => copy(fullSetupCommand, "setup")}
          >
            {isCopied("setup") ? (
              <Check className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <p>After setup, connect with:</p>
          <code className="block bg-muted px-2 py-1 rounded">
            ssh &lt;sandbox-id&gt;@{SSH_HOST_ALIAS}
          </code>
          <code className="block bg-muted px-2 py-1 rounded">
            code --remote ssh-remote+&lt;sandbox-id&gt;@{SSH_HOST_ALIAS}{" "}
            /home/dev/workspace
          </code>
        </div>
      </CardContent>
    </Card>
  );
}

function SshKeySetupDialog({
  sshKey,
  onOpenChange,
}: {
  sshKey: SshKey | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!sshKey} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Key className="h-4 w-4" />
            {sshKey?.name}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            <p>
              <span className="font-medium">Fingerprint:</span>{" "}
              <code className="bg-muted px-1 rounded">
                {sshKey?.fingerprint}
              </code>
            </p>
            {sshKey?.expiresAt && (
              <p className="mt-1">
                <span className="font-medium">Expires:</span>{" "}
                {new Date(sshKey.expiresAt).toLocaleString()}
              </p>
            )}
          </div>

          <SetupInstructions showPrivateKeySetup={false} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddSshKeyDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const createMutation = useCreateSshKey();
  const [mode, setMode] = useState<"generate" | "upload">("upload");
  const [name, setName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [generatedPrivateKey, setGeneratedPrivateKey] = useState<string | null>(
    null,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [supportsGeneration, setSupportsGeneration] = useState<boolean | null>(
    null,
  );

  useState(() => {
    isWebCryptoEd25519Supported().then(setSupportsGeneration);
  });

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const { publicKey: pubKey, privateKey: privKey } =
        await generateEd25519Keypair();
      setPublicKey(pubKey);
      setGeneratedPrivateKey(privKey);
    } catch (error) {
      console.error("Key generation failed:", error);
      window.alert(
        "Failed to generate key. Your browser may not support Ed25519.",
      );
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim() || !publicKey.trim()) return;

    const expiresAt =
      mode === "generate"
        ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    await createMutation.mutateAsync({
      publicKey: publicKey.trim(),
      name: name.trim(),
      type: mode === "generate" ? "generated" : "uploaded",
      expiresAt,
    });

    setName("");
    setPublicKey("");
    setGeneratedPrivateKey(null);
    onSuccess();
  };

  const downloadPrivateKey = () => {
    if (!generatedPrivateKey) return;
    const blob = new Blob([generatedPrivateKey], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name || "sandbox"}_ed25519`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setName("");
      setPublicKey("");
      setGeneratedPrivateKey(null);
      setMode("upload");
    }
    onOpenChange(isOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add SSH Key</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            <Button
              variant={mode === "generate" ? "default" : "outline"}
              onClick={() => setMode("generate")}
              disabled={supportsGeneration === false}
              className="flex-1"
            >
              Generate Key
            </Button>
            <Button
              variant={mode === "upload" ? "default" : "outline"}
              onClick={() => setMode("upload")}
              className="flex-1"
            >
              Upload Key
            </Button>
          </div>

          {supportsGeneration === false && mode === "generate" && (
            <p className="text-sm text-destructive">
              Your browser does not support Ed25519 key generation. Please
              upload an existing key instead.
            </p>
          )}

          <div className="space-y-2">
            <Label>Key Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My laptop key"
            />
          </div>

          {mode === "generate" ? (
            <div className="space-y-4">
              {!generatedPrivateKey ? (
                <Button
                  onClick={handleGenerate}
                  disabled={isGenerating || supportsGeneration === false}
                  className="w-full"
                >
                  {isGenerating ? "Generating..." : "Generate ED25519 Keypair"}
                </Button>
              ) : (
                <>
                  <Card className="border-yellow-500/50 bg-yellow-500/10">
                    <CardContent className="py-3">
                      <p className="text-sm font-medium text-yellow-500">
                        Private Key Generated
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Download and save your private key now. It will not be
                        shown again. This key expires in 30 days.
                      </p>
                    </CardContent>
                  </Card>
                  <div className="flex gap-2">
                    <Button
                      onClick={downloadPrivateKey}
                      variant="outline"
                      className="flex-1"
                    >
                      <Download className="h-4 w-4 mr-2" />
                      Download Private Key
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        navigator.clipboard.writeText(generatedPrivateKey)
                      }
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>

                  <SetupInstructions privateKey={generatedPrivateKey} />

                  <div className="space-y-2">
                    <Label>Public Key (will be saved)</Label>
                    <Textarea
                      value={publicKey}
                      readOnly
                      className="font-mono text-xs h-20"
                    />
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              <Label>Public Key</Label>
              <Textarea
                value={publicKey}
                onChange={(e) => setPublicKey(e.target.value)}
                placeholder="ssh-ed25519 AAAA... user@host"
                className="font-mono text-xs h-24"
              />
              <p className="text-xs text-muted-foreground">
                Paste your public key (usually from ~/.ssh/id_ed25519.pub or
                ~/.ssh/id_rsa.pub)
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={
                !name.trim() || !publicKey.trim() || createMutation.isPending
              }
            >
              {createMutation.isPending ? "Saving..." : "Save Key"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
