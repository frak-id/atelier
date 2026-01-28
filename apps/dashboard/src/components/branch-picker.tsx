import { useQuery } from "@tanstack/react-query";
import { Check, ChevronsUpDown, GitBranch, Loader2, Star } from "lucide-react";
import { useState } from "react";
import { githubBranchesQuery } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface BranchPickerProps {
  owner: string;
  repo: string;
  value: string;
  onChange: (branch: string) => void;
  disabled?: boolean;
}

export function BranchPicker({
  owner,
  repo,
  value,
  onChange,
  disabled,
}: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [manualInput, setManualInput] = useState(false);

  const { data: branches, isLoading } = useQuery({
    ...githubBranchesQuery(owner, repo),
    enabled: !!owner && !!repo && open,
    select: (data) => data?.branches ?? [],
  });

  const filteredBranches = search
    ? (branches ?? []).filter((branch) =>
        branch.name.toLowerCase().includes(search.toLowerCase()),
      )
    : (branches ?? []);

  const handleManualSubmit = () => {
    if (search.trim()) {
      onChange(search.trim());
      setSearch("");
      setManualInput(false);
      setOpen(false);
    }
  };

  if (disabled) {
    return (
      <Button variant="outline" className="w-full justify-start gap-2" disabled>
        <GitBranch className="h-4 w-4" />
        <span className="truncate">{value || "Select branch..."}</span>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
        >
          <span className="flex items-center gap-2 truncate">
            <GitBranch className="h-4 w-4 shrink-0" />
            <span className="truncate">{value || "Select branch..."}</span>
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <div className="p-2 border-b">
          <Input
            placeholder={
              manualInput ? "Enter branch name..." : "Search branches..."
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && manualInput) {
                e.preventDefault();
                handleManualSubmit();
              }
            }}
            className="h-8"
          />
        </div>
        <ScrollArea className="h-[250px]">
          {isLoading ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : manualInput ? (
            <div className="p-2 space-y-2">
              <p className="text-xs text-muted-foreground px-2">
                Type a branch name and press Enter
              </p>
              {search && (
                <button
                  type="button"
                  onClick={handleManualSubmit}
                  className="flex items-center gap-2 w-full p-2 rounded-md text-left hover:bg-accent"
                >
                  <GitBranch className="h-4 w-4" />
                  <span className="font-mono text-sm">Use "{search}"</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setManualInput(false)}
                className="text-xs text-muted-foreground hover:text-foreground px-2"
              >
                ← Back to branch list
              </button>
            </div>
          ) : filteredBranches.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground space-y-2">
              <p>{search ? "No branches found" : "No branches available"}</p>
              <button
                type="button"
                onClick={() => setManualInput(true)}
                className="text-xs text-primary hover:underline"
              >
                Enter branch manually
              </button>
            </div>
          ) : (
            <div className="p-1">
              {filteredBranches.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  onClick={() => {
                    onChange(branch.name);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={cn(
                    "flex items-center gap-2 w-full p-2 rounded-md text-left hover:bg-accent transition-colors",
                    value === branch.name && "bg-accent",
                  )}
                >
                  <GitBranch className="h-4 w-4 shrink-0" />
                  <span className="flex-1 font-mono text-sm truncate">
                    {branch.name}
                  </span>
                  {branch.isDefault && (
                    <Star className="h-3 w-3 text-amber-500 shrink-0" />
                  )}
                  {value === branch.name && (
                    <Check className="h-4 w-4 text-primary shrink-0" />
                  )}
                </button>
              ))}
              <div className="border-t mt-1 pt-1">
                <button
                  type="button"
                  onClick={() => setManualInput(true)}
                  className="flex items-center gap-2 w-full p-2 rounded-md text-left hover:bg-accent text-muted-foreground text-sm"
                >
                  <GitBranch className="h-4 w-4" />
                  Enter branch manually...
                </button>
              </div>
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
