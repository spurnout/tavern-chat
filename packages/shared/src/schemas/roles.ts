import { z } from 'zod';
import { idSchema } from './ids.js';
import { NAME_LIMITS } from '../constants.js';

export const roleSchema = z.object({
  id: idSchema,
  serverId: idSchema,
  name: z.string().min(NAME_LIMITS.MIN_ROLE_NAME).max(NAME_LIMITS.MAX_ROLE_NAME),
  color: z.number().int().min(0).max(0xffffff),
  position: z.number().int().min(0),
  permissions: z.string(),
  mentionable: z.boolean(),
  hoist: z.boolean(),
  isEveryone: z.boolean(),
});

export const createRoleRequestSchema = z.object({
  name: z.string().min(NAME_LIMITS.MIN_ROLE_NAME).max(NAME_LIMITS.MAX_ROLE_NAME),
  color: z.number().int().min(0).max(0xffffff).optional(),
  permissions: z.string().optional(),
  mentionable: z.boolean().optional(),
  hoist: z.boolean().optional(),
});

export const updateRoleRequestSchema = createRoleRequestSchema.partial().extend({
  position: z.number().int().min(0).optional(),
});

export const assignRolesRequestSchema = z.object({
  roleIds: z.array(idSchema),
});

export type Role = z.infer<typeof roleSchema>;
export type CreateRoleRequest = z.infer<typeof createRoleRequestSchema>;
export type UpdateRoleRequest = z.infer<typeof updateRoleRequestSchema>;
export type AssignRolesRequest = z.infer<typeof assignRolesRequestSchema>;
