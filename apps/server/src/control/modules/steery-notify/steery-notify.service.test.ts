/**
 * Which permission prompts the Steery notifier raises, and the request it
 * raises for one.
 */
import { describe, expect, test } from "bun:test";
import { DEFAULT_STEERY_NOTIFY_POLICY } from "@frak/atelier-shared";
import { steeryRequestBody } from "./steery-notifier.ts";
import { notifies } from "./steery-notify.service.ts";

const policy = DEFAULT_STEERY_NOTIFY_POLICY;
const bash = { title: "bash", kind: "execute" };
const read = { title: "Read file", kind: "read" };

describe("notifies", () => {
  test("off raises nothing; all raises everything", () => {
    expect(notifies(policy, "off", bash)).toBe(false);
    expect(notifies(policy, "all", read)).toBe(true);
  });

  test("risky raises prompts at or above minRisk", () => {
    expect(notifies(policy, "risky", bash)).toBe(true);
    expect(notifies(policy, "risky", read)).toBe(false);
    expect(notifies({ ...policy, minRisk: "low" }, "risky", read)).toBe(true);
  });

  test("tools narrows by kind or title", () => {
    const only = { ...policy, tools: ["Execute"] };
    expect(notifies(only, "all", bash)).toBe(true);
    expect(notifies(only, "all", read)).toBe(false);
    expect(notifies({ ...policy, tools: ["read file"] }, "all", read)).toBe(
      true,
    );
  });
});

describe("steeryRequestBody", () => {
  test("offers each option as a button, the reject one as rejection", () => {
    const body = steeryRequestBody("id-1", "my box", {
      sandboxId: "sb1",
      ...bash,
      options: [
        { optionId: "a", name: "Allow once", kind: "allow_once" },
        { optionId: "r", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(body.title).toBe("Let the agent run a command?");
    expect(body.input[0]?.options).toEqual([
      { id: "a", label: "Allow once", stance: "neutral" },
      { id: "r", label: "Reject", stance: "rejection" },
    ]);
  });
});
