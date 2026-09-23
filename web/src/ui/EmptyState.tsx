import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  // The title nests under the heading the state sits beneath: 3 below a
  // Panel's h2, 2 directly under a page's h1.
  headingLevel?: 2 | 3 | 4;
}

// An empty result is an answer, never an error (the fourth refusal layer
// is 200 []); it says what is absent and, where one exists, what to do.
export function EmptyState({ title, children, action, headingLevel = 3 }: EmptyStateProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <div className="empty-state">
      <Heading className="empty-state-title">{title}</Heading>
      {children && <p className="empty-state-body">{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
