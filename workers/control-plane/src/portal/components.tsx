import type { FC } from "hono/jsx";

/** Colored status badge */
export const StatusBadge: FC<{ status: string }> = ({ status }) => {
  return <span class={`badge badge-${status}`}>{status}</span>;
};

/** Flash message banner (success or error) */
export const FlashMessage: FC<{ success?: string; error?: string }> = ({
  success,
  error,
}) => {
  if (success) return <div class="flash flash-success">{success}</div>;
  if (error) return <div class="flash flash-error">{error}</div>;
  return null;
};

/** Format a date string to a readable format */
export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Integration connection pill */
export const IntegrationPill: FC<{
  platform: string;
  connected: boolean;
}> = ({ platform, connected }) => {
  const icon =
    platform === "slack" ? "💬" : platform === "linear" ? "📐" : "🐙";
  return (
    <span
      class={`integration-pill ${connected ? "connected" : "disconnected"}`}
    >
      {icon} {platform} {connected ? "✓" : "✗"}
    </span>
  );
};

/** Inline form for POST actions (buttons that submit forms) */
export const ActionForm: FC<{
  action: string;
  label: string;
  variant?: "primary" | "danger" | "default";
  size?: "sm" | "md";
  confirm?: boolean;
}> = ({ action, label, variant = "default", size = "md", confirm }) => {
  const cls =
    `btn ${variant !== "default" ? `btn-${variant}` : ""} ${size === "sm" ? "btn-sm" : ""}`.trim();
  if (confirm) {
    return (
      <a href={action} class={cls}>
        {label}
      </a>
    );
  }
  return (
    <form method="post" action={action} class="inline">
      <button type="submit" class={cls}>
        {label}
      </button>
    </form>
  );
};
