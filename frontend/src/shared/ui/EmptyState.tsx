import type { ReactNode } from "react";

type EmptyStateProps = {
  children?: ReactNode;
  className?: string;
  description?: ReactNode;
  title?: ReactNode;
};

export function EmptyState({
  children,
  className,
  description,
  title,
}: EmptyStateProps) {
  return (
    <div className={className ? `empty-state ${className}` : "empty-state"}>
      {title ? <strong>{title}</strong> : null}
      {description ? <p>{description}</p> : null}
      {children}
    </div>
  );
}
