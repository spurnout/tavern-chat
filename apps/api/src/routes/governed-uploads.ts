import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UploadRejectedError, type StorageBackend } from '@tavern/media';
import { registerUploadContentParser } from '../lib/upload-content-parser.js';
import type { UploadGovernor } from '../services/upload-governor.js';

export interface GovernedUploadRouteDeps {
  storage: StorageBackend;
  uploadGovernor: UploadGovernor;
  uploadMaxBytes: number;
}

export async function registerGovernedUploadRoutes(
  app: FastifyInstance,
  deps: GovernedUploadRouteDeps,
): Promise<void> {
  const { storage, uploadGovernor, uploadMaxBytes } = deps;

  // Encapsulated scope: the raw-body content-type parsers must only apply to
  // this upload route, not loosen body parsing for the rest of the API.
  await app.register(async (scope) => {
    registerUploadContentParser(scope);

    scope.route({
      method: 'PUT',
      url: '/api/_governed-uploads/:token',
      bodyLimit: uploadMaxBytes,
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      handler: async (req, reply) => {
        const { token } = z.object({ token: z.string().min(8).max(96) }).parse(req.params);
        try {
          await uploadGovernor.acceptGovernedUpload(token, req.raw, storage);
          reply.status(204).send();
        } catch (err) {
          // Only client-caused rejections echo their message; storage and
          // filesystem errors stay in the log so paths don't leak (STO-004).
          if (err instanceof UploadRejectedError) {
            reply
              .status(400)
              .send({ ok: false, error: { code: 'UPLOAD_BLOCKED', message: err.message } });
            return;
          }
          req.log.error({ err }, 'governed upload failed');
          reply
            .status(500)
            .send({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Upload failed' } });
        }
      },
    });
  });
}
