import type { FastifyInstance } from 'fastify';
import { prisma } from '@tavern/db';
import { z } from 'zod';
import {
  characterSystemSchema,
  createCharacterRequestSchema,
  createMacroRequestSchema,
  DiceParseError,
  evaluateDiceNotation,
  expandTemplate,
  idSchema,
  Permission,
  TavernError,
  TemplateError,
  ulid,
  updateCharacterRequestSchema,
  updateMacroRequestSchema,
  validateSheetForSystem,
} from '@tavern/shared';
import { ok } from '../lib/responses.js';
import { requireServerPermission } from '../services/permissions-service.js';
import { gatewayBroker } from '../services/gateway-broker.js';

interface CharacterRow {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  conceptOneLiner: string | null;
  system: string;
  sheetJson: unknown;
  portraitAttachmentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function serializeCharacter(c: CharacterRow): {
  id: string;
  campaignId: string;
  ownerUserId: string;
  name: string;
  conceptOneLiner: string | null;
  system: string;
  sheetJson: unknown;
  portraitAttachmentId: string | null;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: c.id,
    campaignId: c.campaignId,
    ownerUserId: c.ownerUserId,
    name: c.name,
    conceptOneLiner: c.conceptOneLiner,
    system: c.system,
    sheetJson: c.sheetJson,
    portraitAttachmentId: c.portraitAttachmentId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

async function ensureCampaignMember(campaignId: string, userId: string): Promise<{ isGm: boolean; serverId: string }> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { gmUserId: true, serverId: true },
  });
  if (!campaign) throw TavernError.notFound('Campaign not found');
  const member = await prisma.campaignMember.findUnique({
    where: { campaignId_userId: { campaignId, userId } },
  });
  if (!member && campaign.gmUserId !== userId) {
    // Server admin / MANAGE_CAMPAIGNS can read characters.
    try {
      await requireServerPermission(campaign.serverId, userId, Permission.MANAGE_CAMPAIGNS);
    } catch {
      throw TavernError.forbidden('You are not in this campaign');
    }
  }
  return { isGm: campaign.gmUserId === userId, serverId: campaign.serverId };
}

export async function registerCharacterRoutes(app: FastifyInstance): Promise<void> {
  // ---- List campaign characters -----------------------------------------
  app.get('/api/campaigns/:id/characters', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    await ensureCampaignMember(campaignId, ctx.userId);

    const rows = await prisma.character.findMany({
      where: { campaignId },
      orderBy: { name: 'asc' },
    });
    reply.send(ok(rows.map((r) => serializeCharacter(r as CharacterRow))));
  });

  // ---- Get a single character ------------------------------------------
  app.get('/api/characters/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.character.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound('Character not found');
    await ensureCampaignMember(c.campaignId, ctx.userId);
    reply.send(ok(serializeCharacter(c as CharacterRow)));
  });

  // ---- Create -----------------------------------------------------------
  app.post('/api/campaigns/:id/characters', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id: campaignId } = z.object({ id: idSchema }).parse(req.params);
    const body = createCharacterRequestSchema.parse(req.body);
    const { isGm } = await ensureCampaignMember(campaignId, ctx.userId);
    // Members can create their own PC; GMs can create any. (Server admins
    // can too, since ensureCampaignMember admits them via MANAGE_CAMPAIGNS.)
    // No ownership transfer — `ownerUserId` is always the caller for now;
    // GMs can re-assign later via PATCH (deferred).
    void isGm; // currently unused, but ack the helper return shape.

    const system = characterSystemSchema.parse(body.system);
    const sheetJson = validateSheetForSystem(system, {});
    const created = await prisma.character.create({
      data: {
        id: ulid(),
        campaignId,
        ownerUserId: ctx.userId,
        name: body.name,
        conceptOneLiner: body.conceptOneLiner ?? null,
        system,
        sheetJson: sheetJson as object,
        portraitAttachmentId: body.portraitAttachmentId ?? null,
      },
    });
    const dto = serializeCharacter(created as CharacterRow);
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { character: dto, kind: 'create' },
    });
    reply.status(201).send(ok(dto));
  });

  // ---- Patch ------------------------------------------------------------
  app.patch('/api/characters/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateCharacterRequestSchema.parse(req.body);

    const existing = await prisma.character.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Character not found');
    const { isGm } = await ensureCampaignMember(existing.campaignId, ctx.userId);

    if (existing.ownerUserId !== ctx.userId && !isGm) {
      throw TavernError.forbidden('Only the owner or GM can edit this character');
    }
    const sheetJson =
      body.sheetJson !== undefined
        ? validateSheetForSystem(existing.system as 'dnd5e' | 'pbta' | 'generic', body.sheetJson)
        : undefined;

    const updated = await prisma.character.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.conceptOneLiner !== undefined ? { conceptOneLiner: body.conceptOneLiner } : {}),
        ...(body.portraitAttachmentId !== undefined
          ? { portraitAttachmentId: body.portraitAttachmentId }
          : {}),
        ...(sheetJson !== undefined ? { sheetJson: sheetJson as object } : {}),
      },
    });
    const dto = serializeCharacter(updated as CharacterRow);
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { character: dto, kind: 'update' },
    });
    reply.send(ok(dto));
  });

  // ---- Delete -----------------------------------------------------------
  app.delete('/api/characters/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const existing = await prisma.character.findUnique({ where: { id } });
    if (!existing) throw TavernError.notFound('Character not found');
    const { isGm } = await ensureCampaignMember(existing.campaignId, ctx.userId);
    if (existing.ownerUserId !== ctx.userId && !isGm) {
      throw TavernError.forbidden();
    }
    await prisma.character.delete({ where: { id } });
    gatewayBroker.publish({
      type: 'CHARACTER_UPDATE',
      data: { character: { id }, kind: 'delete' },
    });
    reply.send(ok({ id }));
  });

  // ============================================================================
  // Macros
  // ============================================================================

  app.get('/api/characters/:id/macros', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const c = await prisma.character.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound('Character not found');
    await ensureCampaignMember(c.campaignId, ctx.userId);
    const macros = await prisma.characterMacro.findMany({
      where: { characterId: id },
      orderBy: { position: 'asc' },
    });
    reply.send(
      ok(
        macros.map((m) => ({
          id: m.id,
          characterId: m.characterId,
          label: m.label,
          notation: m.notation,
          modifierJson: m.modifierJson,
          position: m.position,
          color: m.color,
        })),
      ),
    );
  });

  app.post('/api/characters/:id/macros', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = createMacroRequestSchema.parse(req.body);
    const c = await prisma.character.findUnique({ where: { id } });
    if (!c) throw TavernError.notFound('Character not found');
    const { isGm } = await ensureCampaignMember(c.campaignId, ctx.userId);
    if (c.ownerUserId !== ctx.userId && !isGm) throw TavernError.forbidden();

    const maxPos = await prisma.characterMacro.aggregate({
      where: { characterId: id },
      _max: { position: true },
    });
    const macro = await prisma.characterMacro.create({
      data: {
        id: ulid(),
        characterId: id,
        label: body.label,
        notation: body.notation,
        modifierJson: (body.modifierJson ?? {}) as object,
        position: (maxPos._max.position ?? -1) + 1,
        color: body.color ?? null,
      },
    });
    reply.status(201).send(
      ok({
        id: macro.id,
        characterId: macro.characterId,
        label: macro.label,
        notation: macro.notation,
        modifierJson: macro.modifierJson,
        position: macro.position,
        color: macro.color,
      }),
    );
  });

  app.patch('/api/macros/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const body = updateMacroRequestSchema.parse(req.body);
    const macro = await prisma.characterMacro.findUnique({
      where: { id },
      include: { character: { select: { campaignId: true, ownerUserId: true } } },
    });
    if (!macro) throw TavernError.notFound('Macro not found');
    const { isGm } = await ensureCampaignMember(macro.character.campaignId, ctx.userId);
    if (macro.character.ownerUserId !== ctx.userId && !isGm) throw TavernError.forbidden();

    const updated = await prisma.characterMacro.update({
      where: { id },
      data: {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.notation !== undefined ? { notation: body.notation } : {}),
        ...(body.modifierJson !== undefined ? { modifierJson: body.modifierJson as object } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
      },
    });
    reply.send(
      ok({
        id: updated.id,
        characterId: updated.characterId,
        label: updated.label,
        notation: updated.notation,
        modifierJson: updated.modifierJson,
        position: updated.position,
        color: updated.color,
      }),
    );
  });

  // Wave 3 #12 — fire a macro with sheet-aware template expansion. Returns
  // the resolved notation and the rolled result; clients can decide whether
  // to post it to a channel.
  app.post('/api/macros/:id/fire', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const macro = await prisma.characterMacro.findUnique({
      where: { id },
      include: { character: { select: { campaignId: true, system: true, sheetJson: true } } },
    });
    if (!macro) throw TavernError.notFound('Macro not found');
    await ensureCampaignMember(macro.character.campaignId, ctx.userId);
    let resolved: string;
    try {
      resolved = expandTemplate(macro.notation, {
        system: macro.character.system as 'dnd5e' | 'pbta' | 'generic',
        sheet: macro.character.sheetJson,
      });
    } catch (err) {
      if (err instanceof TemplateError) {
        throw new TavernError('VALIDATION_ERROR', err.message, 400);
      }
      throw err;
    }
    let rollResult;
    try {
      rollResult = evaluateDiceNotation(resolved);
    } catch (err) {
      if (err instanceof DiceParseError) {
        throw new TavernError('INVALID_DICE_NOTATION', err.message, 400);
      }
      throw err;
    }
    reply.send(ok({ macroId: id, resolvedNotation: resolved, result: rollResult }));
  });

  app.delete('/api/macros/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    const { id } = z.object({ id: idSchema }).parse(req.params);
    const macro = await prisma.characterMacro.findUnique({
      where: { id },
      include: { character: { select: { campaignId: true, ownerUserId: true } } },
    });
    if (!macro) throw TavernError.notFound('Macro not found');
    const { isGm } = await ensureCampaignMember(macro.character.campaignId, ctx.userId);
    if (macro.character.ownerUserId !== ctx.userId && !isGm) throw TavernError.forbidden();
    await prisma.characterMacro.delete({ where: { id } });
    reply.send(ok({ id }));
  });
}
