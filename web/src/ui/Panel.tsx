import type { ReactNode } from "react";

interface PanelProps {
  id: string;
  title: string;
  // The clock this panel's figures are judged at (U18, U48), shown beside
  // the heading so a reader never has to guess which "today" this is.
  judged?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ id, title, judged, actions, children }: PanelProps) {
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel-header">
        <h2 id={id} className="panel-title">
          {title}
        </h2>
        {judged && <p className="panel-judged">{judged}</p>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}
