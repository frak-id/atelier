import type { SandboxBootedFrom } from "@atelier/spec";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelativeTime } from "@/lib/formatters";

const BOOT_KIND_LABEL: Record<SandboxBootedFrom["kind"], string> = {
  prebuild: "prebuild",
  pause: "pause snapshot",
  manual: "manual snapshot",
  fork: "fork snapshot",
};

/** Which prebuild/snapshot the sandbox booted from, and how old it is. */
export function BootedFromCard({
  bootedFrom,
}: {
  bootedFrom: SandboxBootedFrom;
}) {
  const heads = Object.entries(bootedFrom.repoHeads ?? {});
  return (
    <Card>
      <CardHeader>
        <CardTitle>Booted from</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>
          <span className="text-muted-foreground">
            {BOOT_KIND_LABEL[bootedFrom.kind]}
          </span>{" "}
          <span className="font-mono">{bootedFrom.ref}</span>
          <span className="text-muted-foreground">
            {" "}
            · built {formatRelativeTime(bootedFrom.builtAt)}
          </span>
        </p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {bootedFrom.image}
        </p>
        {heads.length > 0 ? (
          <dl className="grid gap-x-4 gap-y-1 pt-1 text-xs sm:grid-cols-2">
            {heads.map(([path, head]) => (
              <div key={path} className="flex min-w-0 gap-2">
                <dt className="shrink-0 font-mono text-muted-foreground">
                  {path}
                </dt>
                <dd className="truncate font-mono">{head.slice(0, 12)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function MetadataSection({
  annotations,
  metadata,
}: {
  annotations?: Record<string, string>;
  metadata?: Record<string, string>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Metadata</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {metadata && Object.keys(metadata).length > 0 ? (
          <DefinitionList title="Metadata" entries={metadata} />
        ) : null}
        {annotations && Object.keys(annotations).length > 0 ? (
          <DefinitionList title="Annotations" entries={annotations} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function DefinitionList({
  title,
  entries,
}: {
  title: string;
  entries: Record<string, string>;
}) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
        {title}
      </h3>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        {Object.entries(entries).map(([key, value]) => (
          <div key={key} className="flex min-w-0 gap-2">
            <dt className="shrink-0 font-mono text-muted-foreground">{key}</dt>
            <dd className="truncate font-mono">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
