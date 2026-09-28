import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RediscoveryPanel } from "./RediscoveryPanel";

vi.mock("../api/client", () => ({
  getToken: () => null,
  authedRequest: vi.fn(),
  API_V1: "/api/v1",
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("RediscoveryPanel", () => {
  it("renders without crashing and shows the disconnected empty state when no token is present", () => {
    renderWithClient(<RediscoveryPanel />);
    expect(screen.getByText(/Connect with a dev token/i)).toBeInTheDocument();
  });
});
