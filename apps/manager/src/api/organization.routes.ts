import { Elysia } from "elysia";
import { organizationService, orgMemberService } from "../container.ts";
import {
  AddOrgMemberBodySchema,
  CreateOrganizationBodySchema,
  OrganizationSchema,
  OrganizationWithRoleListResponseSchema,
  OrgMemberIdParamSchema,
  OrgMemberListResponseSchema,
  OrgSlugParamSchema,
  UpdateOrganizationBodySchema,
  UpdateOrgMemberBodySchema,
} from "../schemas/index.ts";
import { NotFoundError, ValidationError } from "../shared/errors.ts";
import { authPlugin } from "../shared/lib/auth.ts";
import { createChildLogger } from "../shared/lib/logger.ts";

const log = createChildLogger("organization-routes");

export const organizationRoutes = new Elysia({
  prefix: "/organizations",
})
  .use(authPlugin)
  .get(
    "/",
    ({ user }) => {
      return organizationService.getByUserId(user.id);
    },
    {
      response: OrganizationWithRoleListResponseSchema,
    },
  )
  .post(
    "/",
    ({ body, set, user }) => {
      log.info({ name: body.name, slug: body.slug }, "Creating organization");

      const existing = organizationService.getBySlug(body.slug);
      if (existing) {
        throw new ValidationError("Organization slug already taken");
      }

      const org = organizationService.create(body.name, body.slug);
      orgMemberService.addMember(org.id, user.id, "owner");

      set.status = 201;
      return org;
    },
    {
      body: CreateOrganizationBodySchema,
      response: OrganizationSchema,
    },
  )
  .get(
    "/:orgSlug",
    ({ params, user }) => {
      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireMembership(org.id, user.id);
      return org;
    },
    {
      params: OrgSlugParamSchema,
      response: OrganizationSchema,
    },
  )
  .put(
    "/:orgSlug",
    ({ params, body, user }) => {
      log.info({ orgSlug: params.orgSlug }, "Updating organization");

      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireRole(org.id, user.id, ["owner", "admin"]);

      if (org.personal) {
        throw new ValidationError("Cannot modify personal organization");
      }

      return organizationService.update(org.id, body);
    },
    {
      params: OrgSlugParamSchema,
      body: UpdateOrganizationBodySchema,
      response: OrganizationSchema,
    },
  )
  .delete(
    "/:orgSlug",
    ({ params, set, user }) => {
      log.info({ orgSlug: params.orgSlug }, "Deleting organization");

      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireRole(org.id, user.id, ["owner"]);

      if (org.personal) {
        throw new ValidationError("Cannot delete personal organization");
      }

      organizationService.delete(org.id);

      set.status = 204;
      return null;
    },
    {
      params: OrgSlugParamSchema,
    },
  )
  .get(
    "/:orgSlug/members",
    ({ params, user }) => {
      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireMembership(org.id, user.id);
      return orgMemberService.getByOrgId(org.id);
    },
    {
      params: OrgSlugParamSchema,
      response: OrgMemberListResponseSchema,
    },
  )
  .post(
    "/:orgSlug/members",
    ({ params, body, set, user }) => {
      log.info(
        { orgSlug: params.orgSlug, userId: body.userId },
        "Adding organization member",
      );

      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireRole(org.id, user.id, ["owner", "admin"]);

      const member = orgMemberService.addMember(
        org.id,
        body.userId,
        body.role ?? "member",
      );

      set.status = 201;
      return member;
    },
    {
      params: OrgSlugParamSchema,
      body: AddOrgMemberBodySchema,
    },
  )
  .put(
    "/:orgSlug/members/:memberId",
    ({ params, body, user }) => {
      log.info(
        { orgSlug: params.orgSlug, memberId: params.memberId },
        "Updating organization member role",
      );

      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireRole(org.id, user.id, ["owner"]);

      const members = orgMemberService.getByOrgId(org.id);
      const targetMember = members.find((m) => m.id === params.memberId);

      if (!targetMember) {
        throw new NotFoundError("OrgMember", params.memberId);
      }

      return orgMemberService.updateRole(
        org.id,
        targetMember.userId,
        body.role,
      );
    },
    {
      params: OrgMemberIdParamSchema,
      body: UpdateOrgMemberBodySchema,
    },
  )
  .delete(
    "/:orgSlug/members/:memberId",
    ({ params, set, user }) => {
      log.info(
        { orgSlug: params.orgSlug, memberId: params.memberId },
        "Removing organization member",
      );

      const org = organizationService.getBySlugOrThrow(params.orgSlug);
      orgMemberService.requireRole(org.id, user.id, ["owner", "admin"]);

      const members = orgMemberService.getByOrgId(org.id);
      const targetMember = members.find((m) => m.id === params.memberId);

      if (!targetMember) {
        throw new NotFoundError("OrgMember", params.memberId);
      }

      orgMemberService.removeMember(org.id, targetMember.userId);

      set.status = 204;
      return null;
    },
    {
      params: OrgMemberIdParamSchema,
    },
  );
