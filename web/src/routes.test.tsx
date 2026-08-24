import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AppRoutes } from "./routes";

// VehicleList fetches through TanStack Query, so it throws without a client
// in scope. A fresh client per render keeps one test's cache out of the next.
function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppRoutes", () => {
  it("renders the vehicle list at the root", () => {
    renderAt("/");
    expect(screen.getByRole("heading", { name: /vehicles/i })).toBeDefined();
  });

  it("renders a not-found view for an unknown path", () => {
    renderAt("/nowhere");
    expect(screen.getByText(/not found/i)).toBeDefined();
  });
});
