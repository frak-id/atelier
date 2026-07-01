import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/control/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
});
