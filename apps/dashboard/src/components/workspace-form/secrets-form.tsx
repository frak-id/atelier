import {
  type EnvSecret,
  EnvSecretsForm,
  parseEnvSecrets,
  serializeEnvSecrets,
} from "./env-secrets-form";
import {
  type FileSecretInput,
  FileSecretsForm,
  parseFileSecrets,
  serializeFileSecrets,
} from "./file-secrets-form";

interface SecretsFormProps {
  envSecrets: EnvSecret[];
  fileSecrets: FileSecretInput[];
  onEnvSecretsChange: (secrets: EnvSecret[]) => void;
  onFileSecretsChange: (secrets: FileSecretInput[]) => void;
}

export function SecretsForm({
  envSecrets,
  fileSecrets,
  onEnvSecretsChange,
  onFileSecretsChange,
}: SecretsFormProps) {
  return (
    <div className="space-y-6">
      <EnvSecretsForm secrets={envSecrets} onChange={onEnvSecretsChange} />
      <div className="border-t pt-4">
        <FileSecretsForm secrets={fileSecrets} onChange={onFileSecretsChange} />
      </div>
    </div>
  );
}

export {
  parseEnvSecrets,
  parseFileSecrets,
  serializeEnvSecrets,
  serializeFileSecrets,
  type EnvSecret,
  type FileSecretInput,
};
