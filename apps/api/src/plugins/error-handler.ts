import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCodes, TavernError } from '@tavern/shared';
import { fail } from '../lib/responses.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, req, reply) => {
    if (error instanceof TavernError) {
      reply.status(error.statusCode).send(error.toJSON());
      return;
    }

    if (error instanceof ZodError) {
      reply.status(400).send(fail(ErrorCodes.VALIDATION_ERROR, 'Invalid request', error.flatten()));
      return;
    }

    const fastifyError = error as FastifyError;

    // Fastify validation errors (from JSON schema)
    if (fastifyError.validation) {
      reply
        .status(400)
        .send(fail(ErrorCodes.VALIDATION_ERROR, fastifyError.message, fastifyError.validation));
      return;
    }

    if (fastifyError.statusCode === 429) {
      reply.status(429).send(fail(ErrorCodes.RATE_LIMITED, 'Too many requests'));
      return;
    }

    if (fastifyError.statusCode === 404) {
      reply.status(404).send(fail(ErrorCodes.NOT_FOUND, 'Not found'));
      return;
    }

    req.log.error({ err: error }, 'Unhandled error');
    reply.status(500).send(fail(ErrorCodes.INTERNAL_ERROR, 'Internal server error'));
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send(fail(ErrorCodes.NOT_FOUND, 'Not found'));
  });
}
