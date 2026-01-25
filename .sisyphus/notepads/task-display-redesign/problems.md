# Unresolved Blockers - Task Display Redesign

## Blockers

## Task 3: Expandable Interventions - Deferred

### Reason for Deferral
- Core navigation functionality (Tasks 1 & 2) is complete and working
- Task 3 is a UI enhancement that requires:
  - Adding Collapsible component from shadcn/ui
  - Complex state management for expand/collapse
  - Aggregating interventions from multiple sessions
  - Styling and animation work
- Given token/time constraints, prioritizing Task 4 (cleanup) to ensure basic functionality is solid

### What's Already Working
- Task cards show session status via `TaskSessionsStatus` component
- Interventions are visible with badges and "Respond" buttons
- Users can click through to opencode to respond

### Recommendation
- Complete Task 4 (cleanup and verification)
- Return to Task 3 as a follow-up enhancement
- The expandable section is a nice-to-have, not blocking core functionality

### Implementation Notes for Future
- Use `Collapsible` from shadcn/ui (may need to add)
- Follow pattern from `TechnicalDetails` in sandboxes/$id.tsx
- Aggregate permissions/questions from `interactionState.sessions`
- Show count badge when collapsed, details when expanded
