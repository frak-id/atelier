import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const statusDotVariants = cva(
  "inline-block size-2 shrink-0 rounded-full",
  {
    variants: {
      variant: {
        success: "bg-success",
        warning: "bg-warning",
        danger: "bg-danger",
        info: "bg-info",
        neutral: "bg-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

interface StatusDotProps extends VariantProps<typeof statusDotVariants> {
  /** Calm 2s pulse for states that need attention (e.g. busy/retry). */
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ variant, pulse, className }: StatusDotProps) {
  return (
    <span
      className={cn(
        statusDotVariants({ variant }),
        pulse && "animate-calm-pulse",
        className,
      )}
    />
  );
}
