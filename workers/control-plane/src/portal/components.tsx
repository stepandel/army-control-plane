import type { FC } from "hono/jsx";

export const StatusBadge: FC<{ status: string }> = ({ status }) => (
  <span class={`badge badge-${status}`}>{status}</span>
);

export const PlatformBadge: FC<{ platform: string }> = ({ platform }) => (
  <span class={`platform-badge platform-${platform}`}>{platform}</span>
);

export const TimeAgo: FC<{ date: string }> = ({ date }) => {
  const d = new Date(date);
  return (
    <span class="time-relative" title={d.toISOString()}>
      {d.toISOString().slice(0, 16).replace("T", " ")} UTC
    </span>
  );
};

export const Toast: FC<{
  type: "success" | "error" | "info";
  message: string;
}> = ({ type, message }) => (
  <div class={`toast toast-${type}`}>{message}</div>
);

export const Spinner: FC = () => (
  <span class="spinner htmx-indicator" />
);
