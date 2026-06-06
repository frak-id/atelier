import { useUserMap } from "@/api/queries";
import { cn } from "@/lib/utils";

export function SandboxCreator({
  userId,
  className,
}: {
  userId?: string;
  className?: string;
}) {
  const userMap = useUserMap();

  if (!userId) return null;
  const user = userMap.get(userId);
  if (!user) return null;

  return (
    <span
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground min-w-0",
        className,
      )}
      title={`Created by ${user.username}`}
    >
      {user.avatarUrl && (
        <img
          src={user.avatarUrl}
          alt={user.username}
          className="h-4 w-4 rounded-full shrink-0"
        />
      )}
      <span className="truncate">{user.username}</span>
    </span>
  );
}
