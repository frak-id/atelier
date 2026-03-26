import type { Static } from "elysia";
import { t as Type } from "elysia";

const PodInfoSchema = Type.Object({
  name: Type.String(),
  status: Type.String(),
  ready: Type.Boolean(),
  restarts: Type.Number(),
  startedAt: Type.Nullable(Type.String()),
  cpu: Type.Nullable(Type.String()),
  memory: Type.Nullable(Type.String()),
});

export const BuildKitStatusSchema = Type.Object({
  enabled: Type.Boolean(),
  pods: Type.Array(PodInfoSchema),
  pvcs: Type.Array(
    Type.Object({
      name: Type.String(),
      capacity: Type.String(),
      phase: Type.String(),
    }),
  ),
});

export type BuildKitStatus = Static<typeof BuildKitStatusSchema>;

export const RunnersStatusSchema = Type.Object({
  enabled: Type.Boolean(),
  pods: Type.Array(
    Type.Intersect([
      PodInfoSchema,
      Type.Object({
        runnerId: Type.String(),
      }),
    ]),
  ),
  activeJobs: Type.Number(),
  idleRunners: Type.Number(),
  totalRunners: Type.Number(),
});

export type RunnersStatus = Static<typeof RunnersStatusSchema>;

export const PlatformOverviewSchema = Type.Object({
  buildkit: BuildKitStatusSchema,
  runners: RunnersStatusSchema,
});

export type PlatformOverview = Static<typeof PlatformOverviewSchema>;
