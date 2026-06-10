import type { FastifyContentTypeParser, FastifyInstance } from 'fastify';

const REGISTERED = Symbol.for('tavern.uploadContentParserRegistered');

type FastifyWithUploadParserFlag = FastifyInstance & {
  [REGISTERED]?: boolean;
};

/**
 * Register pass-through (raw stream) body parsers for upload media types.
 * Call this on an encapsulated Fastify scope that contains only body-receiving
 * upload routes — registering these on the root app would loosen content-type
 * handling for every other route.
 */
export function registerUploadContentParser(app: FastifyInstance): void {
  const flagged = app as FastifyWithUploadParserFlag;
  if (flagged[REGISTERED]) return;

  const passThroughBody: FastifyContentTypeParser = (_req, payload, done) => {
    done(null, payload);
  };

  app.addContentTypeParser('application/octet-stream', passThroughBody);
  app.addContentTypeParser('application/pdf', passThroughBody);
  app.addContentTypeParser('text/plain', passThroughBody);
  app.addContentTypeParser(/^image\//, passThroughBody);
  app.addContentTypeParser(/^audio\//, passThroughBody);
  app.addContentTypeParser(/^video\//, passThroughBody);
  flagged[REGISTERED] = true;
}
