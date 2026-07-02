import { useQuery } from "@tanstack/react-query";
import { organizationsListQuery } from "@/api/queries/organizations";
import { Label } from "@/components/ui/label";

/**
 * Native select over the caller's organizations. `value` is the selected org
 * id, or "" for the optional no-org scope (`noneLabel`); omit `noneLabel` to
 * force a concrete org choice.
 */
export function OrgSelect({
  id,
  value,
  onChange,
  noneLabel,
}: {
  id: string;
  value: string;
  onChange: (orgId: string) => void;
  noneLabel?: string;
}) {
  const { data: orgs } = useQuery(organizationsListQuery());

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Organization</Label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        {noneLabel !== undefined ? <option value="">{noneLabel}</option> : null}
        {orgs?.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
    </div>
  );
}
