import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Image {
  id: string;
  name: string;
}

interface GeneralFormProps {
  name: string;
  baseImage: string;
  vcpus: number;
  memoryMb: number;
  images: Image[];
  onNameChange: (value: string) => void;
  onBaseImageChange: (value: string) => void;
  onVcpusChange: (value: number) => void;
  onMemoryMbChange: (value: number) => void;
  useRegistryCache?: boolean;
  onUseRegistryCacheChange?: (value: boolean) => void;
  showName?: boolean;
}

export function GeneralForm({
  name,
  baseImage,
  vcpus,
  memoryMb,
  images,
  onNameChange,
  onBaseImageChange,
  onVcpusChange,
  onMemoryMbChange,
  useRegistryCache,
  onUseRegistryCacheChange,
  showName = true,
}: GeneralFormProps) {
  return (
    <div className="space-y-4">
      {showName && (
        <div className="space-y-2">
          <Label htmlFor="name">Workspace Name</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
          />
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="image">Base Image</Label>
        <Select value={baseImage} onValueChange={onBaseImageChange}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {images.map((image) => (
              <SelectItem key={image.id} value={image.id}>
                {image.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="vcpus">vCPUs</Label>
          <Select
            value={String(vcpus)}
            onValueChange={(value) => onVcpusChange(Number.parseInt(value, 10))}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">1 vCPU</SelectItem>
              <SelectItem value="2">2 vCPUs</SelectItem>
              <SelectItem value="4">4 vCPUs</SelectItem>
              <SelectItem value="8">8 vCPUs</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="memory">Memory</Label>
          <Select
            value={String(memoryMb)}
            onValueChange={(value) =>
              onMemoryMbChange(Number.parseInt(value, 10))
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1024">1 GB</SelectItem>
              <SelectItem value="2048">2 GB</SelectItem>
              <SelectItem value="4096">4 GB</SelectItem>
              <SelectItem value="8192">8 GB</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {onUseRegistryCacheChange && (
        <div className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4">
          <Checkbox
            id="useRegistryCache"
            checked={useRegistryCache ?? true}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              onUseRegistryCacheChange(e.target.checked)
            }
          />
          <div className="space-y-1 leading-none">
            <Label htmlFor="useRegistryCache">Use npm registry cache</Label>
            <p className="text-sm text-muted-foreground">
              Enable local caching for npm packages to speed up builds.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
