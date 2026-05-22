import type { ReactNode } from "react";

type StatusMessageProps = {
  children: ReactNode;
  className?: string;
  tone?: "default" | "muted" | "warn" | "error";
};

export function StatusMessage({
  children,
  className,
  tone = "default",
}: StatusMessageProps) {
  const toneClassName =
    tone === "default"
      ? "status"
      : tone === "error"
        ? "status status-error"
        : tone === "warn"
          ? "status status-warn"
          : "status status-muted";

  return (
    <p className={className ? `${toneClassName} ${className}` : toneClassName}>
      {children}
    </p>
  );
}
