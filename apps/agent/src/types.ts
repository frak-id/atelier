import type { DiscoverableConfigCategory } from "@frak-sandbox/shared/constants";
import { t } from "elysia";

export interface AppPort {
  port: number;
  name: string;
  registeredAt: string;
}

export interface DiscoveredConfig {
  path: string;
  displayPath: string;
  category: DiscoverableConfigCategory | "other";
  exists: boolean;
  size?: number;
}

export const AppRegistrationSchema = t.Object({
  port: t.Number({ minimum: 1, maximum: 65535 }),
  name: t.String(),
});

export const ExecRequestSchema = t.Object({
  command: t.String(),
  timeout: t.Optional(t.Number({ minimum: 1000, maximum: 300000 })),
});

export const ConfigReadQuerySchema = t.Object({
  path: t.String(),
});
