import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  backLink?: {
    to: string;
    label: string;
  };
}

export function PageHeader({
  title,
  description,
  actions,
  backLink,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
      <div>
        {backLink && (
          <a
            href={backLink.to}
            className="text-sm text-muted-foreground hover:text-foreground mb-1 inline-flex items-center gap-1"
          >
            <span>←</span> {backLink.label}
          </a>
        )}
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && (
          <p className="text-muted-foreground text-sm mt-1">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex items-center gap-2 mt-4 sm:mt-0">{actions}</div>
      )}
    </div>
  );
}
