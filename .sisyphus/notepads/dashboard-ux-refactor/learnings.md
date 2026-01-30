
## Mission Control Implementation
- Rewrote home page (`index.tsx`) to be a "Mission Control" dashboard.
- Implemented `useAttentionData` hook to aggregate permissions and questions across all running sandboxes using `useQueries` and `flatMap`.
- Used `SectionErrorBoundary` to handle API failures gracefully for each section, preventing the entire dashboard from crashing when the backend is unavailable.
- Reused `SandboxCard` and `StartWorkingCard` to maintain consistency.
- Integrated `SandboxDrawer` and `TaskDrawer` with page-level state management (`useState`).
- Handling `useSuspenseQuery` (used in `StartWorkingCard`) requires an `ErrorBoundary` as it throws on error, unlike `useQuery`.
