import { useEffect, useState } from "react";
import { formatRelativeTime } from "@/lib/utils";

interface TimeAgoProps {
  date: string | Date | number;
  className?: string;
  updateInterval?: number;
}

export function TimeAgo({
  date,
  className,
  updateInterval = 60000,
}: TimeAgoProps) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), updateInterval);
    return () => clearInterval(timer);
  }, [updateInterval]);

  return (
    <time dateTime={new Date(date).toISOString()} className={className}>
      {formatRelativeTime(date)}
    </time>
  );
}
