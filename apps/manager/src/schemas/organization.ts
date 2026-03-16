import type { Static } from "elysia";
import { t } from "elysia";

export const OrgMemberRoleSchema = t.Union([
  t.Literal("owner"),
  t.Literal("admin"),
  t.Literal("member"),
  t.Literal("viewer"),
]);
export type OrgMemberRole = Static<typeof OrgMemberRoleSchema>;

export const OrganizationSchema = t.Object({
  id: t.String(),
  name: t.String(),
  slug: t.String(),
  avatarUrl: t.Optional(t.String()),
  personal: t.Boolean(),
  createdAt: t.String(),
  updatedAt: t.String(),
});
export type Organization = Static<typeof OrganizationSchema>;

export const CreateOrganizationBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 100 }),
  slug: t.String({ minLength: 1, maxLength: 50, pattern: "^[a-z0-9-]+$" }),
});
export type CreateOrganizationBody = Static<
  typeof CreateOrganizationBodySchema
>;

export const UpdateOrganizationBodySchema = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  avatarUrl: t.Optional(t.String()),
});
export type UpdateOrganizationBody = Static<
  typeof UpdateOrganizationBodySchema
>;

export const OrganizationListResponseSchema = t.Array(OrganizationSchema);
export type OrganizationListResponse = Static<
  typeof OrganizationListResponseSchema
>;

export const OrganizationWithRoleSchema = t.Intersect([
  OrganizationSchema,
  t.Object({ role: OrgMemberRoleSchema }),
]);
export type OrganizationWithRole = Static<typeof OrganizationWithRoleSchema>;

export const OrganizationWithRoleListResponseSchema = t.Array(
  OrganizationWithRoleSchema,
);
export type OrganizationWithRoleListResponse = Static<
  typeof OrganizationWithRoleListResponseSchema
>;

export const TransferWorkspaceBodySchema = t.Object({
  orgId: t.String({ minLength: 1 }),
});
export type TransferWorkspaceBody = Static<typeof TransferWorkspaceBodySchema>;

export const OrgMemberSchema = t.Object({
  id: t.String(),
  orgId: t.String(),
  userId: t.String(),
  username: t.String(),
  avatarUrl: t.Optional(t.String()),
  role: OrgMemberRoleSchema,
  joinedAt: t.String(),
});
export type OrgMember = Static<typeof OrgMemberSchema>;

export const AddOrgMemberBodySchema = t.Object({
  userId: t.String({ minLength: 1 }),
  role: t.Optional(OrgMemberRoleSchema),
});
export type AddOrgMemberBody = Static<typeof AddOrgMemberBodySchema>;

export const UpdateOrgMemberBodySchema = t.Object({
  role: OrgMemberRoleSchema,
});
export type UpdateOrgMemberBody = Static<typeof UpdateOrgMemberBodySchema>;

export const OrgMemberListResponseSchema = t.Array(OrgMemberSchema);
export type OrgMemberListResponse = Static<typeof OrgMemberListResponseSchema>;

export const UserSchema = t.Object({
  id: t.String(),
  username: t.String(),
  email: t.String(),
  avatarUrl: t.Optional(t.String()),
  personalOrgId: t.Optional(t.String()),
  createdAt: t.String(),
  lastLoginAt: t.String(),
});
export type User = Static<typeof UserSchema>;

export const UserListResponseSchema = t.Array(UserSchema);

export const OrgSlugParamSchema = t.Object({
  orgSlug: t.String({ minLength: 1 }),
});
export type OrgSlugParam = Static<typeof OrgSlugParamSchema>;

export const OrgMemberIdParamSchema = t.Object({
  orgSlug: t.String({ minLength: 1 }),
  memberId: t.String({ minLength: 1 }),
});
export type OrgMemberIdParam = Static<typeof OrgMemberIdParamSchema>;
