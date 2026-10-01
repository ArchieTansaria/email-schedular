import { extname } from 'node:path';

import { Router, type ErrorRequestHandler, type RequestHandler } from 'express';
import multer from 'multer';

import type { CampaignScheduler } from './campaign-scheduler.js';
import {
  CampaignEnqueueError,
  IdempotencyConflictError,
  SchedulingValidationError,
  SenderUnavailableError,
} from './errors.js';
import { extractLeadCandidates } from './lead-parser.js';

const MAX_LEAD_FILE_BYTES = 5 * 1024 * 1024;
const acceptedMimeTypes = new Set(['text/plain', 'text/csv', 'application/csv']);
const acceptedExtensions = new Set(['.txt', '.csv']);

interface SchedulingRouterOptions {
  scheduler: CampaignScheduler;
  authenticate?: RequestHandler | undefined;
  logger: { error(bindings: Record<string, unknown>, message: string): void };
}

class TransportValidationError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_LEAD_FILE_BYTES, files: 1, fields: 8 },
  fileFilter: (_request, file, callback) => {
    const extension = extname(file.originalname).toLowerCase();
    if (acceptedMimeTypes.has(file.mimetype) && acceptedExtensions.has(extension)) {
      callback(null, true);
      return;
    }
    callback(new TransportValidationError('file must be a CSV or TXT file'));
  },
});

export function createSchedulingRouter({
  scheduler,
  authenticate,
  logger,
}: SchedulingRouterOptions): Router {
  const router = Router();
  const middleware = authenticate ? [authenticate] : [];

  router.post(
    '/',
    ...middleware,
    requireAuthenticatedPrincipal,
    requireIdempotencyKey,
    upload.single('file'),
    async (request, response) => {
      const principal = response.locals.principal;
      if (!principal) {
        response.status(401).json(errorBody('UNAUTHENTICATED', 'Authentication is required'));
        return;
      }

      try {
        const idempotencyKey = requireHeader(request.get('Idempotency-Key'));
        const file = request.file;
        if (!file) throw new TransportValidationError('file is required');

        const result = await scheduler.scheduleCampaign({
          userId: principal.userId,
          senderId: requireField(request.body.senderId, 'senderId'),
          subject: requireField(request.body.subject, 'subject'),
          body: requireField(request.body.body, 'body'),
          startAt: parseDateField(request.body.startAt, 'startAt'),
          delayMs: parseIntegerField(request.body.delayMs, 'delayMs'),
          hourlyLimit: parseIntegerField(request.body.hourlyLimit, 'hourlyLimit'),
          idempotencyKey,
          recipients: extractLeadCandidates(file.buffer.toString('utf8')),
        });

        response.status(202).json(result);
      } catch (error) {
        if (error instanceof TransportValidationError) {
          response.status(400).json(errorBody('BAD_REQUEST', error.message));
          return;
        }
        if (error instanceof SchedulingValidationError) {
          response
            .status(400)
            .json({ error: { code: error.code, message: error.message, issues: error.issues } });
          return;
        }
        if (error instanceof SenderUnavailableError) {
          response.status(404).json(errorBody(error.code, 'Sender is unavailable'));
          return;
        }
        if (error instanceof IdempotencyConflictError) {
          response.status(409).json(errorBody(error.code, error.message));
          return;
        }
        if (error instanceof CampaignEnqueueError) {
          response.status(503).json({
            error: {
              code: 'QUEUE_ENQUEUE_FAILED',
              message:
                'Campaign was saved, but queueing failed; retry with the same Idempotency-Key',
              campaignId: error.campaignId,
            },
          });
          return;
        }

        logger.error({ error }, 'Scheduling request failed unexpectedly');
        response.status(500).json(errorBody('INTERNAL_ERROR', 'Internal server error'));
      }
    },
  );

  return router;
}

export function schedulingUploadErrorHandler(): ErrorRequestHandler {
  return (error, _request, response, next) => {
    if (error instanceof multer.MulterError) {
      const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      response.status(status).json(errorBody(error.code, uploadErrorMessage(error)));
      return;
    }
    if (error instanceof TransportValidationError) {
      response.status(400).json(errorBody('INVALID_FILE', error.message));
      return;
    }
    next(error);
  };
}

const requireAuthenticatedPrincipal: RequestHandler = (_request, response, next) => {
  if (!response.locals.principal) {
    response.status(401).json(errorBody('UNAUTHENTICATED', 'Authentication is required'));
    return;
  }
  next();
};

const requireIdempotencyKey: RequestHandler = (request, response, next) => {
  if (!request.get('Idempotency-Key')?.trim()) {
    response.status(400).json(errorBody('BAD_REQUEST', 'Idempotency-Key header is required'));
    return;
  }
  next();
};

function requireHeader(value: string | undefined): string {
  if (!value?.trim()) throw new TransportValidationError('Idempotency-Key header is required');
  return value.trim();
}

function requireField(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TransportValidationError(`${name} is required`);
  return value;
}

function parseIntegerField(value: unknown, name: string): number {
  const text = requireField(value, name);
  if (!/^-?\d+$/.test(text)) throw new TransportValidationError(`${name} must be an integer`);
  const number = Number(text);
  if (!Number.isSafeInteger(number))
    throw new TransportValidationError(`${name} must be an integer`);
  return number;
}

function parseDateField(value: unknown, name: string): Date {
  const text = requireField(value, name);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()))
    throw new TransportValidationError(`${name} must be a valid date`);
  return date;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

function uploadErrorMessage(error: multer.MulterError): string {
  if (error.code === 'LIMIT_FILE_SIZE') return 'file must not exceed 5 MB';
  if (error.code === 'LIMIT_FILE_COUNT') return 'only one file is allowed';
  if (error.code === 'LIMIT_FIELD_COUNT') return 'too many form fields';
  return 'invalid multipart request';
}
