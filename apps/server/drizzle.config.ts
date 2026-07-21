import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: ["./src/control/db/schema.ts", "./src/runtime/db/schema.ts"],
  out: "./drizzle",
  dialect: "sqlite",
});
