import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@/api/queries/error";
import { queryKeys } from "@/api/queries/keys";
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
} from "@/components/route-error";
import { ThemeProvider } from "@/providers/theme";
import "./index.css";
import { routeTree } from "./routeTree.gen";

/** A 401 from any call means the session may be over (expired JWT, GitHub
 * token revoked): re-check it, and the root shows the login page if so. */
function recheckSessionOn401(error: unknown) {
  if (error instanceof ApiError && error.status === 401) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.auth.me });
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: recheckSessionOn401 }),
  mutationCache: new MutationCache({ onError: recheckSessionOn401 }),
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
    mutations: {
      onError: (error) => {
        console.error("[Mutation Error]", error);
      },
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  defaultErrorComponent: RouteErrorComponent,
  defaultNotFoundComponent: RouteNotFoundComponent,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
