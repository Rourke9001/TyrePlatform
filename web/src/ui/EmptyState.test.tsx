import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders the title, the explanation and the action", () => {
    render(
      <EmptyState title="No spares" action={<a href="/fleet">Units</a>}>
        No spare position carries a tyre.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { name: "No spares" })).toBeInTheDocument();
    expect(screen.getByText("No spare position carries a tyre.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Units" })).toBeInTheDocument();
  });
});
