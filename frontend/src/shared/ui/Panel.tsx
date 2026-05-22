import type { ElementType, ReactNode } from "react";

type PanelProps = {
  actions?: ReactNode;
  as?: ElementType;
  children: ReactNode;
  className?: string;
  kicker?: string;
  title?: ReactNode;
};

export function Panel({
  actions,
  as: Component = "section",
  children,
  className,
  kicker,
  title,
}: PanelProps) {
  return (
    <Component className={className ? `panel ${className}` : "panel"}>
      {title || kicker || actions ? (
        <div className="panel-head">
          <div>
            {kicker ? <p className="section-kicker">{kicker}</p> : null}
            {title ? <h2>{title}</h2> : null}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </Component>
  );
}
