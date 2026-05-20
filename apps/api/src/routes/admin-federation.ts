import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAPABILITIES, TavernError } from '@tavern/shared';
import { ok } from '../lib/responses.js';
import type { FederationPeeringService } from '../services/federation-peering.js';
import type { FederationKeyStore } from '../services/federation-keys.js';
import type { Config } from '../config.js';

export interface AdminFederationDeps {
  service: FederationPeeringService;
  keys: FederationKeyStore;
  config: Config;
}

export function registerAdminFederationRoutes(app: FastifyInstance, deps: AdminFederationDeps): void {
  const selfHost = new URL(deps.config.PUBLIC_BASE_URL).host;
  const signer = (bytes: Buffer): Buffer => deps.keys.sign(bytes);

  app.get('/api/admin/peers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admins only');
    const peers = await deps.service.listPeers();
    reply.send(ok({ peers }));
  });

  app.post('/api/admin/peers', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admins only');
    const body = z.object({
      host: z.string().min(1).max(253),
      requestedCapabilities: z.array(z.enum(CAPABILITIES)).default([...CAPABILITIES]),
      note: z.string().max(500).optional(),
    }).parse(req.body);
    const r = await deps.service.initiatePeering({
      host: body.host,
      adminUserId: ctx.userId,
      requestedCapabilities: body.requestedCapabilities,
      note: body.note,
      sign: signer,
      selfHost,
    });
    reply.code(201).send(ok({ remoteInstanceId: r.remoteInstanceId }));
  });

  app.post('/api/admin/peers/:id/approve', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admins only');
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    await deps.service.approvePeer({ id, adminUserId: ctx.userId, selfHost, sign: signer });
    reply.send(ok({ id, status: 'peered' }));
  });

  app.delete('/api/admin/peers/:id', async (req, reply) => {
    const ctx = await app.requireUser(req, reply);
    if (!ctx.isInstanceAdmin) throw TavernError.forbidden('Instance admins only');
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const body = z.object({ reason: z.string().max(500).optional() }).parse(req.body ?? {});
    await deps.service.revokePeer({ id, reason: body.reason, selfHost, sign: signer });
    reply.send(ok({ id, status: 'revoked' }));
  });
}
