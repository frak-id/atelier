import { describe, expect, test } from "bun:test";
import { permissionPresentation } from "./permission.ts";

describe("permissionPresentation by ACP tool kind", () => {
  const cases = [
    ["delete", "high", "Destructive"],
    ["execute", "high", "Runs code"],
    ["edit", "medium", "Changes files"],
    ["move", "medium", "Changes files"],
    ["fetch", "medium", "Network access"],
    ["read", "low", "Read-only"],
    ["search", "low", "Read-only"],
    ["think", "low", "Read-only"],
    ["switch_mode", "medium", "Changes behaviour"],
  ] as const;
  for (const [kind, risk, riskLabel] of cases) {
    test(kind, () => {
      const p = permissionPresentation("whatever", kind);
      expect(p.risk).toBe(risk);
      expect(p.riskLabel).toBe(riskLabel);
    });
  }

  test("the kind wins over a contradicting label", () => {
    expect(permissionPresentation("Read file", "delete").risk).toBe("high");
  });

  test("`other` and unknown kinds fall back to the label", () => {
    expect(permissionPresentation("bash", "other").risk).toBe("high");
    expect(permissionPresentation("bash", "mystery").risk).toBe("high");
  });
});

describe("permissionPresentation label heuristic", () => {
  test("matches whole words only", () => {
    expect(permissionPresentation("runtime.ts")).toEqual({
      what: "runtime.ts",
      risk: "medium",
      riskLabel: "Unrecognised",
    });
    expect(permissionPresentation("Run tests").riskLabel).toBe("Runs code");
    expect(permissionPresentation("rm -rf dist").risk).toBe("high");
    expect(permissionPresentation("firmware").riskLabel).toBe("Unrecognised");
  });

  test("classifies the common labels", () => {
    expect(permissionPresentation("Edit file").riskLabel).toBe("Changes files");
    expect(permissionPresentation("webfetch").riskLabel).toBe("Network access");
    expect(permissionPresentation("Read file").risk).toBe("low");
  });

  test("a backticked command is code execution", () => {
    expect(permissionPresentation("`git push`").riskLabel).toBe("Runs code");
  });

  test("unknown labels stay verbatim at medium", () => {
    expect(permissionPresentation("Frobnicate")).toEqual({
      what: "Frobnicate",
      risk: "medium",
      riskLabel: "Unrecognised",
    });
  });
});
