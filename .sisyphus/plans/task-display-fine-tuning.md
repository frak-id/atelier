# Task Display Fine-Tuning

## Context

### User Requirements
From screenshot and feedback:
1. **Session name display**: Show `{session.name}` first, then template ID
2. **Subsession expandable**: Sessions with children should be expandable recursively
3. **Action button repositioning**: Move button bar below title and creation time

### Current Issues
- Session display shows template ID first: "implement (ses_xxx)"
- No subsession expansion in detail page (hierarchy exists but not used)
- Action buttons appear to be in wrong position (in header area)

---

## Work Objectives

### Core Objective
Fine-tune task detail page layout and session display to improve UX.

### Concrete Deliverables
1. Updated session display showing session name first
2. Expandable subsessions using HierarchicalSessionList component
3. Repositioned action button bar below title

### Definition of Done
- [x] Session display shows: `{session.name} - {templateId} (ses_xxx) [open] timestamp`
- [x] Sessions with subsessions show count and are expandable
- [x] Subsession expansion is recursive
- [x] Action button bar positioned below title and creation time
- [x] TypeScript passes
- [x] Layout looks correct

---

## TODOs

- [ ] 1. Update Session Display Format

  **What to do**:
  - Update session display in `apps/dashboard/src/routes/tasks/$id.tsx`
  - Show session name first: `{session.name} - {templateId} (ses_xxx)`
  - Session name comes from OpenCode Session object
  - Keep status indicator, open link, timestamp
  
  **Current location**: Around lines 450-475 (session list rendering)
  
  **Pattern**:
  ```tsx
  {session.name} - {session.templateId} (ses_{session.id.slice(0, 8)})
  ```

- [ ] 2. Replace Flat Session List with Hierarchical Display

  **What to do**:
  - Replace current flat session list with `HierarchicalSessionList` component
  - Use `allSessions` from `useTaskSessionHierarchy` hook
  - Component already exists and handles subsession expansion
  - Shows "(X sub-sessions)" when collapsed
  - Recursive expansion/collapse
  
  **References**:
  - `apps/dashboard/src/components/hierarchical-session-list.tsx` - Component to use
  - Already have `allSessions` from hierarchy hook
  
  **Pattern**:
  ```tsx
  <HierarchicalSessionList
    sessions={allSessions}
    showSandboxInfo={false}
  />
  ```

- [ ] 3. Reposition Action Button Bar

  **What to do**:
  - Move action button bar from header area to below title
  - Layout should be:
    ```
    [Back Arrow] Title [Status Badge]
    Created {timestamp}
    [Action Buttons Row: VSCode, OpenCode, Terminal, SSH, Complete, Reset, Delete]
    
    [Rest of content...]
    ```
  - Currently buttons might be in CardHeader or mixed with title
  - Should be their own row below the metadata
  
  **Current location**: Check lines 115-200 for header/action area

- [ ] 4. Cleanup and Verification

  **What to do**:
  - Run typecheck
  - Verify layout in browser (need manual QA)
  - Ensure subsession expansion works
  - Ensure action buttons are accessible and functional

---

## Verification Strategy

Manual browser testing required:
1. Navigate to task detail page
2. Verify session names display correctly
3. Verify sessions with subsessions show count
4. Click to expand subsessions
5. Verify recursive expansion works
6. Verify action buttons are below title
7. Verify all buttons still functional

---

## Notes

### Session Name Source
OpenCode Session object has `name` property that should be displayed.

### HierarchicalSessionList
Already exists and handles:
- Recursive subsession display
- Expand/collapse with chevron icons
- Count display when collapsed
- Proper indentation for hierarchy levels

### Action Button Layout
From screenshot, looks like buttons are in the same row as title/back button.
Should be moved to their own row below the metadata section.
