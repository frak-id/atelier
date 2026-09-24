import { Pencil } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Click-to-edit text: reads as plain text (with a pencil on hover), turns
 * into a field on click. Enter (or blur) saves, Escape cancels. `multiline`
 * uses a textarea where Enter saves and Shift+Enter adds a line.
 *
 * Built for people who don't think in forms: no Save button to find, and an
 * empty value shows the placeholder as an invitation ("Add a note…").
 */
export function InlineEdit({
  value,
  onSave,
  placeholder,
  multiline = false,
  required = false,
  maxLength,
  autoEdit = false,
  className,
  inputClassName,
  label,
}: {
  value: string;
  onSave: (next: string) => void;
  placeholder: string;
  multiline?: boolean;
  /** Refuse an empty save (keeps the previous value). */
  required?: boolean;
  maxLength?: number;
  /** Open in edit mode on mount (a freshly created workspace). */
  autoEdit?: boolean;
  className?: string;
  inputClassName?: string;
  /** Accessible name for the field. */
  label: string;
}) {
  const [editing, setEditing] = useState(autoEdit);
  const [draft, setDraft] = useState(value);
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);

  // Follow server updates while not editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }
  }, [editing]);

  function commit() {
    setEditing(false);
    const next = draft.trim();
    if (next === value.trim()) return;
    if (required && !next) {
      setDraft(value);
      return;
    }
    onSave(next);
  }

  function cancel() {
    setDraft(value);
    setEditing(false);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && !(multiline && event.shiftKey)) {
      event.preventDefault();
      commit();
    }
  }

  if (editing) {
    const shared = {
      ref: fieldRef,
      value: draft,
      maxLength,
      placeholder,
      "aria-label": label,
      onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
      onBlur: commit,
      onKeyDown,
      className: cn(
        "w-full rounded-md border border-input bg-background px-2 py-1 shadow-xs outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        inputClassName,
      ),
    };
    return multiline ? (
      <textarea rows={2} {...shared} />
    ) : (
      <input type="text" {...shared} />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit"
      className={cn(
        "group -mx-2 flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/60",
        className,
      )}
    >
      <span
        className={cn(
          "min-w-0 whitespace-pre-wrap break-words",
          !value && "text-muted-foreground italic",
        )}
      >
        {value || placeholder}
      </span>
      <Pencil className="mt-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </button>
  );
}
