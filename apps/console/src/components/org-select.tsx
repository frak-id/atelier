import { useQuery } from "@tanstack/react-query";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

/**
 * Native select over the caller's organizations. `value` is the selected org
 * id, or "" for the optional no-org scope (`noneLabel`); omit `noneLabel` to
 * force a concrete org choice. `markPersonal` suffixes the caller's personal
 * org's name with "(personal)" and the team org's with "(default)" so a
 * default selection reads clearly.
 */
export function OrgSelect({
  id,
  value,
  onChange,
  noneLabel,
  markPersonal,
}: {
  id: string;
  value: string;
  onChange: (orgId: string) => void;
  noneLabel?: string;
  markPersonal?: boolean;
}) {
  const { data: orgs, isError } = useQuery(organizationsListQuery());

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Organization</Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {noneLabel !== undefined ? <option value="">{noneLabel}</option> : null}
        {orgs?.map((org) => (
          <option key={org.id} value={org.id}>
            {markPersonal && org.mine
              ? `${org.name} (personal)`
              : markPersonal && org.default
                ? `${org.name} (default)`
                : org.name}
          </option>
        ))}
      </NativeSelect>
      {isError ? (
        <p className="text-xs text-destructive">
          Failed to load organizations.
        </p>
      ) : null}
    </div>
  );
}
