export interface SessionTemplate {
  id: string;
  name: string;
  category: "primary" | "secondary";
  description?: string;
  promptTemplate?: string;
  variants: Array<{
    name: string;
    model: { providerID: string; modelID: string };
    variant?: string;
    agent?: string;
  }>;
  defaultVariantIndex?: number;
}

export const DEFAULT_SESSION_TEMPLATES: SessionTemplate[] = [
  {
    id: "implement",
    name: "Implementation",
    category: "primary",
    description: "Main development work",
    variants: [
      {
        name: "Low Effort",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
      {
        name: "Medium Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "high",
        agent: "build",
      },
      {
        name: "High Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "max",
        agent: "build",
      },
      {
        name: "Maximum Effort",
        model: { providerID: "anthropic", modelID: "claude-opus-4-5" },
        variant: "max",
        agent: "plan",
      },
    ],
    defaultVariantIndex: 1,
  },
  {
    id: "best-practices",
    name: "Best Practices Review",
    category: "secondary",
    description: "Review code for best practices and patterns",
    promptTemplate: `Review the changes made in this task for best practices:

1. Check for code quality issues (naming, structure, readability)
2. Identify missing error handling or edge cases
3. Suggest improvements to patterns and architecture
4. Flag any anti-patterns or code smells

Focus on actionable feedback. If changes are needed, implement them directly.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
  {
    id: "security-review",
    name: "Security Review",
    category: "secondary",
    description: "Analyze code for security vulnerabilities",
    promptTemplate: `Perform a security review of the changes made in this task:

1. Check for injection vulnerabilities (SQL, XSS, command injection)
2. Review authentication and authorization logic
3. Identify sensitive data exposure risks
4. Check for insecure dependencies or configurations
5. Review input validation and sanitization

Flag any security issues found and implement fixes directly.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
  {
    id: "simplification",
    name: "Simplification",
    category: "secondary",
    description: "Simplify and refactor code",
    promptTemplate: `Review and simplify the code changes in this task:

1. Remove unnecessary complexity and abstractions
2. Consolidate duplicate code
3. Simplify conditional logic
4. Improve function/method signatures
5. Remove dead code

Make the code as simple as possible while maintaining functionality.`,
    variants: [
      {
        name: "Standard",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4-5" },
        variant: "high",
        agent: "build",
      },
    ],
    defaultVariantIndex: 0,
  },
];

export const SESSION_TEMPLATES_CONFIG_PATH = "/.atelier/session-templates.json";
