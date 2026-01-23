import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`;
}

export function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

export function formatDate(date: string | Date | number): string {
  return new Date(date).toLocaleString();
}

export function formatRelativeTime(date: string | Date | number): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const diff = now - then;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

export function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function buildOpenCodeSessionUrl(
  baseUrl: string,
  directory: string,
  sessionId: string,
): string {
  return `${baseUrl}/${base64UrlEncode(directory)}/session/${sessionId}`;
}

/**
 * Calculate days until a given expiration date
 * Returns negative value if already expired
 */
export function getDaysUntilExpiration(expiresAt: string): number {
  const now = Date.now();
  const expires = new Date(expiresAt).getTime();
  return Math.ceil((expires - now) / (1000 * 60 * 60 * 24));
}

export type SshKeyExpirationStatus =
  | { status: "valid"; daysRemaining: number }
  | { status: "expiring_soon"; daysRemaining: number }
  | { status: "expired" }
  | { status: "no_expiration" };

/**
 * Get the expiration status for an SSH key
 * - "expiring_soon" if within 3 days
 * - "expired" if past expiration
 * - "valid" otherwise
 * - "no_expiration" for uploaded keys without expiration
 */
export function getSshKeyExpirationStatus(
  expiresAt: string | null,
): SshKeyExpirationStatus {
  if (!expiresAt) {
    return { status: "no_expiration" };
  }

  const daysRemaining = getDaysUntilExpiration(expiresAt);

  if (daysRemaining <= 0) {
    return { status: "expired" };
  }

  if (daysRemaining <= 3) {
    return { status: "expiring_soon", daysRemaining };
  }

  return { status: "valid", daysRemaining };
}
