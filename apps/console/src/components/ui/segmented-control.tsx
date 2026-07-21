import { cn } from "@/lib/utils";

export interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A small, tab-like exclusive-choice control — used for the Operator/Builder
 * lens toggle and similar two/three-way display preferences. Not built on
 * Radix Tabs: it's a value picker with no associated panels.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    // Toggle-button group (not tabs: there are no associated tabpanels, and not
    // a native radio group: these are styled buttons). Each button carries
    // `aria-pressed` for exclusive-choice semantics without a phantom tabpanel
    // contract or a native-element role that misrepresents the styled control.
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md bg-muted p-1",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "rounded-sm px-2.5 py-1 text-sm font-medium transition-colors duration-200 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              selected
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
