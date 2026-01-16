import { Elysia, t } from "elysia";
import { ProjectModel } from "./model.ts";
import { ProjectService } from "../../services/project.ts";
import { NotFoundError } from "../../lib/errors.ts";
import { createChildLogger } from "../../lib/logger.ts";

const log = createChildLogger("projects-route");

export const projectRoutes = new Elysia({ prefix: "/projects" })
  .get(
    "/",
    async ({ query }) => {
      let projects = await ProjectService.list();

      if (query.prebuildStatus) {
        projects = projects.filter(
          (p) => p.prebuildStatus === query.prebuildStatus,
        );
      }

      return projects;
    },
    {
      query: ProjectModel.listQuery,
      response: t.Array(ProjectModel.response),
    },
  )
  .post(
    "/",
    async ({ body, set }) => {
      log.info({ body }, "Creating project");
      const project = await ProjectService.create(body);
      set.status = 201;
      return project;
    },
    {
      body: ProjectModel.create,
      response: ProjectModel.response,
    },
  )
  .get(
    "/:id",
    async ({ params }) => {
      const project = await ProjectService.getById(params.id);
      if (!project) {
        throw new NotFoundError("Project", params.id);
      }
      return project;
    },
    {
      params: ProjectModel.idParam,
      response: ProjectModel.response,
    },
  )
  .put(
    "/:id",
    async ({ params, body }) => {
      const existing = await ProjectService.getById(params.id);
      if (!existing) {
        throw new NotFoundError("Project", params.id);
      }

      log.info({ projectId: params.id, body }, "Updating project");
      const project = await ProjectService.update(params.id, body);
      return project;
    },
    {
      params: ProjectModel.idParam,
      body: ProjectModel.update,
      response: ProjectModel.response,
    },
  )
  .delete(
    "/:id",
    async ({ params, set }) => {
      const project = await ProjectService.getById(params.id);
      if (!project) {
        throw new NotFoundError("Project", params.id);
      }

      log.info({ projectId: params.id }, "Deleting project");
      await ProjectService.delete(params.id);

      set.status = 204;
      return null;
    },
    {
      params: ProjectModel.idParam,
    },
  )
  .post(
    "/:id/prebuild",
    async ({ params, set }) => {
      const project = await ProjectService.getById(params.id);
      if (!project) {
        throw new NotFoundError("Project", params.id);
      }

      log.info({ projectId: params.id }, "Triggering prebuild");
      await ProjectService.triggerPrebuild(params.id);

      set.status = 202;
      return { message: "Prebuild triggered", projectId: params.id };
    },
    {
      params: ProjectModel.idParam,
      response: t.Object({
        message: t.String(),
        projectId: t.String(),
      }),
    },
  );
