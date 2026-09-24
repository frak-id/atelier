import type { LaunchpadIcon } from "@atelier/spec";
import {
  Book,
  Bot,
  Bug,
  ChartColumn,
  Code,
  Database,
  Eye,
  FlaskConical,
  Globe,
  LayoutTemplate,
  type LucideIcon,
  Megaphone,
  MessageSquare,
  Palette,
  PenLine,
  Rocket,
  Shield,
  Sparkles,
  SquareTerminal,
} from "lucide-react";
import type { BadgeVariant } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** The curated icon set (keys from `LAUNCHPAD_ICONS` in `@atelier/spec`). */
const LAUNCHPAD_ICON_COMPONENTS: Record<LaunchpadIcon, LucideIcon> = {
  sparkles: Sparkles,
  rocket: Rocket,
  globe: Globe,
  eye: Eye,
  layout: LayoutTemplate,
  palette: Palette,
  pen: PenLine,
  message: MessageSquare,
  bot: Bot,
  code: Code,
  terminal: SquareTerminal,
  book: Book,
  database: Database,
  chart: ChartColumn,
  shield: Shield,
  bug: Bug,
  flask: FlaskConical,
  megaphone: Megaphone,
};

function iconFor(key: string | undefined, fallback: LucideIcon): LucideIcon {
  if (key && key in LAUNCHPAD_ICON_COMPONENTS) {
    return LAUNCHPAD_ICON_COMPONENTS[key as LaunchpadIcon];
  }
  return fallback;
}

/** A starter/service icon: a curated key, with a sensible fallback for an
 * unknown or missing one (never an error). */
export function LaunchpadIconView({
  icon,
  fallback = Sparkles,
  className,
}: {
  icon?: string;
  fallback?: LucideIcon;
  className?: string;
}) {
  const Icon = iconFor(icon, fallback);
  return <Icon className={cn("size-5", className)} strokeWidth={1.75} />;
}

type Phase = "preparing" | "starting" | "ready" | "sleeping" | "failed";

interface PhasePresentation {
  label: string;
  /** One reassuring sentence for the workspace page. */
  hint: string;
  variant: BadgeVariant;
  dot: "success" | "warning" | "danger" | "info" | "neutral";
  busy: boolean;
}

/** Plain-English status copy. No "sandbox", "pod" or "resume" here. */
export const PHASE_PRESENTATION: Record<Phase, PhasePresentation> = {
  preparing: {
    label: "Setting up",
    hint: "Getting everything ready for you. The first time can take a couple of minutes.",
    variant: "info",
    dot: "info",
    busy: true,
  },
  starting: {
    label: "Starting",
    hint: "Almost there, your tools are starting up.",
    variant: "info",
    dot: "info",
    busy: true,
  },
  ready: {
    label: "Ready",
    hint: "Everything is up and running.",
    variant: "success",
    dot: "success",
    busy: false,
  },
  sleeping: {
    label: "Asleep",
    hint: "Your work is saved. Wake it up to continue where you left off.",
    variant: "neutral",
    dot: "neutral",
    busy: false,
  },
  failed: {
    label: "Needs attention",
    hint: "Something went wrong while starting. You can try again.",
    variant: "danger",
    dot: "danger",
    busy: false,
  },
};

/** "Morning", "Afternoon", "Evening" — a warmer landing headline. */
export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}
