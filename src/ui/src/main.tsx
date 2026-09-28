import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { ApplicantStatusPortal } from "./components/ApplicantStatusPortal";
import "./styles/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

// The Applicant Status Portal is a separate, public-facing surface from
// the internal staff dashboard — served at /portal, with no CommandBar,
// no staff dev-token dependency, and its own OTP-based session. A path
// check here (rather than a routing library) keeps this a zero-new-
// dependency addition, consistent with the rest of this UI shell.
const isPortalRoute = window.location.pathname.startsWith("/portal");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {isPortalRoute ? <ApplicantStatusPortal /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>
);
