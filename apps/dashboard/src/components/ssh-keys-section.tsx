import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Copy, Download, Key, Plus, Trash2 } from "lucide-react";
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

export function SshKeysSection() {
  const { data: keys, isLoading } = useQuery(sshKeysListQuery);
  const deleteMutation = useDeleteSshKey();
  const [addDialogOpen, setAddDialogOpen] = useState(false);

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
          <Card key={key.id}>
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
                {key.expiresAt && (
                  <span className="text-xs text-orange-500">
                    Expires: {new Date(key.expiresAt).toLocaleDateString()}
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => {
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
    </div>
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
        ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
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
                        shown again. This key expires in 24 hours.
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
