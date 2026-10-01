import {
  SlackNotConnectedError,
  SlackProviderError,
  type SlackClient,
  type SlackIntegrationService,
  type SlackOAuthStateStore,
} from '@reachinbox/slack';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

const callbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(32).max(256),
});

interface SlackLogger {
  error(bindings: Record<string, unknown>, message: string): void;
}

export function createSlackRouter(options: {
  authenticate?: RequestHandler | undefined;
  stateStore: SlackOAuthStateStore;
  slackClient: SlackClient;
  integrations: SlackIntegrationService;
  clientId: string;
  redirectUri: string;
  frontendUrl: string;
  logger: SlackLogger;
}): Router {
  const router = Router();
  const requireAuthentication: RequestHandler = (request, response, next) => {
    options.authenticate?.(request, response, (error?: unknown) => {
      if (error) return next(error);
      if (!response.locals.principal) {
        response
          .status(401)
          .json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
        return;
      }
      next();
    });
    if (!options.authenticate) {
      response
        .status(401)
        .json({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required' } });
    }
  };

  router.get('/status', requireAuthentication, async (_request, response) => {
    response.status(200).json(await options.integrations.status(response.locals.principal!.userId));
  });

  router.get('/connect', requireAuthentication, async (_request, response) => {
    const state = await options.stateStore.create(response.locals.principal!.userId);
    const authorizeUrl = new URL('https://slack.com/oauth/v2/authorize');
    authorizeUrl.search = new URLSearchParams({
      client_id: options.clientId,
      scope: 'incoming-webhook',
      redirect_uri: options.redirectUri,
      state,
    }).toString();
    response.redirect(302, authorizeUrl.toString());
  });

  router.get('/callback', async (request, response) => {
    const parsed = callbackSchema.safeParse(request.query);
    if (!parsed.success) {
      response.status(400).json({
        error: {
          code: 'INVALID_OAUTH_CALLBACK',
          message: 'Missing or invalid Slack OAuth code/state',
        },
      });
      return;
    }
    const userId = await options.stateStore.consume(parsed.data.state);
    if (!userId) {
      response.status(400).json({
        error: {
          code: 'INVALID_OAUTH_STATE',
          message: 'Slack OAuth state is invalid, expired, or already used',
        },
      });
      return;
    }
    try {
      const installation = await options.slackClient.exchangeCode(parsed.data.code);
      await options.integrations.install(userId, installation);
      const destination = new URL(options.frontendUrl);
      destination.searchParams.set('slack', 'connected');
      response.redirect(302, destination.toString());
    } catch (error) {
      options.logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          operation: 'slack-oauth-callback',
        },
        'Slack OAuth callback failed',
      );
      response.status(502).json({
        error: {
          code: 'SLACK_OAUTH_FAILED',
          message: 'Slack authorization could not be completed',
        },
      });
    }
  });

  router.delete('/', requireAuthentication, async (_request, response) => {
    try {
      await options.integrations.disconnect(response.locals.principal!.userId);
      response.status(200).json({ connected: false });
    } catch (error) {
      options.logger.error(
        {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          operation: 'slack-disconnect',
        },
        'Slack disconnect failed; local integration retained',
      );
      response.status(502).json({
        error: {
          code: 'SLACK_DISCONNECT_FAILED',
          message: 'Slack could not be disconnected; the existing connection was retained',
        },
      });
    }
  });

  router.post('/test', requireAuthentication, async (_request, response) => {
    try {
      await options.integrations.sendTest(response.locals.principal!.userId);
      response.status(200).json({ status: 'success' });
    } catch (error) {
      if (error instanceof SlackNotConnectedError) {
        response.status(409).json({ status: 'not_connected' });
        return;
      }
      options.logger.error(
        {
          errorName: error instanceof Error ? error.name : SlackProviderError.name,
          operation: 'slack-test',
        },
        'Slack test notification failed',
      );
      response.status(502).json({ status: 'provider_failure' });
    }
  });

  return router;
}
