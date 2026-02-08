import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  RouteErrorComponent,
  RouteNotFoundComponent,
} from "@/components/route-error";
import { loadConfig } from "./config";
import "./index.css";
import { ManagerEventsProvider } from "./providers/manager-events-provider";
import { OpencodeEventsProvider } from "./providers/opencode-events-provider";
import { routeTree } from "./routeTree.gen";

const queryClient = new QueryClient({
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

async function bootstrap() {
  await loadConfig();

  const rootElement = document.getElementById("root");
  if (rootElement) {
    createRoot(rootElement).render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <ManagerEventsProvider>
            <OpencodeEventsProvider>
              <RouterProvider router={router} />
            </OpencodeEventsProvider>
          </ManagerEventsProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
  }
}

bootstrap();
