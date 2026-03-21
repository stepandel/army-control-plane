import type { FC } from "hono/jsx";

interface StatusBadgeProps {
  status: string;
}

export const StatusBadge: FC<StatusBadgeProps> = ({ status }) => {
  const className = `badge badge-${status}`;
  return <span class={className}>{status}</span>;
};

interface PlatformBadgeProps {
  platform: string;
  connected: boolean;
}

export const PlatformBadge: FC<PlatformBadgeProps> = ({ platform, connected }) => {
  if (!connected) return null;
  return <span class={`badge badge-${platform}`}>{platform}</span>;
};
