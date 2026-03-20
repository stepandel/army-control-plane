import type { FC } from "hono/jsx";
import { Toast } from "./components";

export const SuccessToast: FC<{ message: string }> = ({ message }) => (
  <Toast type="success" message={message} />
);

export const ErrorToast: FC<{ message: string }> = ({ message }) => (
  <Toast type="error" message={message} />
);

export const InfoToast: FC<{ message: string }> = ({ message }) => (
  <Toast type="info" message={message} />
);

export const BulkResultToast: FC<{
  action: string;
  total: number;
  succeeded: number;
  failed: number;
}> = ({ action, total, succeeded, failed }) => (
  <Toast
    type={failed > 0 ? "error" : "success"}
    message={`${action}: ${succeeded}/${total} succeeded${failed > 0 ? `, ${failed} failed` : ""}`}
  />
);
