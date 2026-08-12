import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isAuthorized } from './auth.js';
import {
  formatGatewayAnthropicModels,
  formatOpenAIModels,
  gatewayDisplayName,
  supportsDirectOpenAIChatCompletions,
  type GatewayModelOptions,
  type ModelCatalog,
  type ServerModelInfo,
  upstreamModelId,
} from './models.js';
import {
  translateOpenAiRequest,
  generateOpenAiResponse,
  streamOpenAiResponse,
  type OpenAiRequest,
} from '../openai-adapter.js';
import { sendJson, readBody } from '../http-utils.js';
import { relayAnthropicMessages, resolveOAuthRetryReplacement } from '../upstream-forward.js';
import {
  anthropicPromptTooLongMessage,
  estimateAnthropicInputTokens,
} from '../anthropic-endpoints.js';
import { resolveProviderCredential } from '../env.js';
import {
  normalizeBetaTokens,
  resolveCapabilityBetaTokens,
  resolveNativeIdentitySuppression,
} from '../anthropic-beta-policy.js';
import {
  getLatestMessagePreview,
  writeInferenceRequestLog,
  writeInferenceResponseErrorLog,
  writeSecureLogLine,
  resetTraceLog,
  writeWebSocketDiagnosticLog,
  writeWebSocketDiagnosticRequestLog,
  type InferenceRequestLogEntry,
} from '../trace-log.js';
import type { LanguageModel } from 'ai';
import { createLanguageModel, isSdkMigratedNpm, maxToolsForNpm } from '../provider-factory.js';
import {
  anthropicErrorType,
  formatUpstreamError,
  isContextLengthExceededError,
  sdkUpstreamErrorDetails,
  upstreamHttpStatus,
} from '../upstream-error.js';
import { resolveContextWindow } from '../context-window.js';
import {
  translateRequest as sdkTranslateRequest,
  streamAnthropicResponse,
  generateAnthropicResponse,
  silenceSdkWarnings,
  anthropicEffortFromRequest,
  extractClaudeSessionId,
  isOpenAiOAuthRoute,
  oauthServiceTier,
  type AnthropicRequest,
} from '../sdk-adapter.js';
import { withResponsesWebSocketDiagnosticContext } from '../oauth/responses-websocket.js';
import { listenTcpServer, tcpListenerUrlHost } from '../listener-ready.js';
import {
  describeModelAliasRejection,
  modelAliasMatchesStoredName,
  type ModelAliasRejection,
} from '../model-aliases.js';
import { routeUnavailableMessage } from '../route-unavailable.js';
import { transformOpenAiCompatibleRequestBody } from '../model-runtime-compatibility.js';
import {
  DEFAULT_UNSUPPORTED_EFFORT_POLICY,
  EffortResolutionError,
  nativeEffortLevel,
  resolveRequestEffort,
  type UnsupportedEffortPolicy,
} from '../effort-policy.js';

export interface ServerOptions {
  host: string;
  port: number;
  apiKey: string;
  serverPassword: string | null;
  catalog: ModelCatalog;
  gateway?: GatewayModelOptions;
  /**
   * Saved short alias names (clodex models --alias) accepted as request model
   * ids. Used only to preserve the response `model` echo: an aliased request
   * must be echoed back with the exact id the client sent (see CLAUDE.md's
   * auto-compaction/context-window echo invariant).
   */
  aliasNames?: ReadonlySet<string>;
  /** Saved configured aliases rejected before catalog construction. */
  modelAliasRejections?: readonly ModelAliasRejection[];
  /** When set, append structured debug lines to this file path. */
  debugLogPath?: string;
  /** When set, append privacy-minimal inference routing records as JSONL. */
  inferenceLogPath?: string;
  /** Opt-in request-envelope and WebSocket head-decision diagnostics. */
  webSocketDiagnosticsLogPath?: string;
  /** Global behavior for an explicit effort the target model cannot run. */
  effortPolicy?: UnsupportedEffortPolicy;
}

export interface ServerHandle {
  host: string;
  port: number;
  url: string;
  server: Server;
  inferenceLogPath?: string;
  close: () => Promise<void>;
}

type JsonBody = Record<string, any>;

type PLog = (msg: string | (() => string)) => void;
type LanguageModelCache = Map<string, { apiKey: string; languageModel: LanguageModel }>;

function makeServerLog(debugLogPath: string | undefined): PLog {
  if (!debugLogPath) return () => {};
  resetTraceLog(debugLogPath);
  return (msg) => writeSecureLogLine(debugLogPath, typeof msg === 'function' ? msg() : msg);
}

function auditInference(options: ServerOptions, entry: InferenceRequestLogEntry): void {
  if (options.inferenceLogPath) writeInferenceRequestLog(options.inferenceLogPath, entry);
}

function inferenceProvider(model: ServerModelInfo): string {
  return model.providerId ?? String(model.sourceBackend);
}

async function resolveModelApiKey(
  model: ServerModelInfo,
  fallback: string,
  rejectedAccessToken?: string,
): Promise<string> {
  if (model.authType === 'oauth' && model.providerId && model.authRef) {
    let current: string | null;
    try {
      current = rejectedAccessToken === undefined
        ? await resolveProviderCredential(model.providerId, model.authRef)
        : await resolveProviderCredential(
            model.providerId,
            model.authRef,
            undefined,
            { rejectedAccessToken },
          );
    } catch (cause) {
      throw new Error(
        `OAuth credential is unavailable for ${model.providerId}`,
        { cause },
      );
    }
    if (!current) {
      throw new Error(`OAuth credential is unavailable for ${model.providerId}`);
    }
    model.apiKey = current;
    return current;
  }
  return model.apiKey ?? fallback;
}

function auditSdkError(
  options: ServerOptions,
  requestedModelId: string,
  model: ServerModelInfo,
  err: unknown,
  message: string,
): { statusCode: number; retryAfterSeconds?: number } {
  const details = sdkUpstreamErrorDetails(err);
  const statusCode = details?.statusCode ?? upstreamHttpStatus(err, message);
  if (options.inferenceLogPath && statusCode >= 400) {
    writeInferenceResponseErrorLog(options.inferenceLogPath, {
      modelId: requestedModelId,
      provider: inferenceProvider(model),
      route: 'translated',
      statusCode,
      errorContent: details?.errorContent ?? message,
      isRetryable: details?.isRetryable,
      attemptCount: details?.attemptCount,
    });
  }
  return { statusCode, retryAfterSeconds: details?.retryAfterSeconds };
}

function openAiEffort(body: JsonBody): string | undefined {
  if (typeof body.reasoning_effort === 'string' && body.reasoning_effort.trim()) {
    return body.reasoning_effort.trim();
  }
  const reasoning = body.reasoning;
  if (reasoning && typeof reasoning === 'object' && typeof reasoning.effort === 'string' && reasoning.effort.trim()) {
    return reasoning.effort.trim();
  }
  return undefined;
}

export async function startServer(options: ServerOptions): Promise<ServerHandle> {
  silenceSdkWarnings();
  const languageModelCache: LanguageModelCache = new Map();
  const plog = makeServerLog(options.debugLogPath);

  const server = createServer((req, res) => {
    void routeRequest(req, res, options, languageModelCache, plog);
  });

  const address = await listenTcpServer(server, options.port, options.host);

  return {
    host: options.host,
    port: address.port,
    url: `http://${tcpListenerUrlHost(address.address)}:${address.port}`,
    server,
    inferenceLogPath: options.inferenceLogPath,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(err => (err ? reject(err) : resolve()));
    }),
  };
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, options: ServerOptions, modelCache: LanguageModelCache, plog: PLog): Promise<void> {
  try {
    const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    plog(`${req.method} ${pathname}`);

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (!isAuthorized(toRequest(req), options.serverPassword)) {
      sendJson(res, 401, { error: { message: 'Unauthorized' } });
      return;
    }

    if (req.method === 'GET' && pathname === '/models') {
      sendJson(res, 200, {
        models: options.catalog.list().map(({
          apiKey: _apiKey,
          authRef: _authRef,
          headers: _headers,
          oauthAccountId: _oauthAccountId,
          providerData: _providerData,
          ...rest
        }) => rest),
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/anthropic/v1/models') {
      sendJson(res, 200, formatGatewayAnthropicModels(options.catalog.list(), options.gateway));
      return;
    }

    if (req.method === 'GET' && pathname === '/openai/v1/models') {
      sendJson(res, 200, formatOpenAIModels(options.catalog.list()));
      return;
    }

    if (req.method === 'POST' && pathname === '/anthropic/v1/messages') {
      await handleAnthropicMessages(req, res, options, modelCache, plog);
      return;
    }

    if (req.method === 'POST' && pathname === '/anthropic/v1/messages/count_tokens') {
      await handleAnthropicCountTokens(req, res, options, plog);
      return;
    }

    if (req.method === 'POST' && pathname === '/openai/v1/chat/completions') {
      await handleOpenAIChatCompletions(req, res, options, modelCache, plog);
      return;
    }

    sendJson(res, 404, { error: { message: 'Not found' } });
  } catch (err) {
    sendJson(res, 500, { error: { message: err instanceof Error ? err.message : String(err) } });
  }
}

async function handleAnthropicMessages(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: LanguageModelCache,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options, body.model);
  if (!model) {
    plog(`model not found: ${body.model}`);
    return;
  }
  const requestId = randomUUID();
  const claudeSessionIdHeader = Array.isArray(req.headers['x-claude-code-session-id'])
    ? req.headers['x-claude-code-session-id'][0]
    : req.headers['x-claude-code-session-id'];
  const claudeSessionId = extractClaudeSessionId(body as AnthropicRequest, claudeSessionIdHeader);
  if (options.webSocketDiagnosticsLogPath) {
    writeWebSocketDiagnosticRequestLog(options.webSocketDiagnosticsLogPath, {
      requestId,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: model.modelFormat === 'anthropic' ? 'passthrough' : 'translated',
      headers: req.headers,
      body,
    });
  }

  plog(() => `anthropic-messages model=${body.model} format=${model.modelFormat} npm=${model.npm ?? 'none'} stream=${body.stream}`);

  if (model.modelFormat === 'anthropic') {
    if (model.baseUrl && !/^https?:\/\//i.test(model.baseUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider baseUrl: must be http:// or https://` } });
      return;
    }
    if (!model.baseUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no Anthropic baseUrl configured` } });
      return;
    }
    const messagesUrl = `${model.baseUrl}/v1/messages`;
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    const clientWantsStream = Boolean(body.stream);
    const forwardBody: Record<string, unknown> = { ...body, model: upstreamModelId(model) };
    const authType = model.authType ?? 'api';
    const isOAuth = authType === 'oauth';

    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body as AnthropicRequest) ?? model.defaultEffort,
      claudeSessionId,
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });

    // Forwarded verbatim: no metadata user identity and no billing system line.
    // The client's beta travels on as NON-AUTHORITATIVE context only; the relay
    // recomputes the outbound set at the wire boundary from the configured
    // headers plus whichever capability tokens this exact destination, route and
    // body earn. Everything else the client asked for is dropped there.
    const clientBeta = normalizeBetaTokens(req.headers['anthropic-beta']);
    const suppression = resolveNativeIdentitySuppression(model.baseUrl);
    const capability = {
      clientBeta,
      requestedModelId: typeof body.model === 'string' ? body.model : undefined,
      advertisedModelId: model.id,
      advertisedContextWindow: model.contextWindow,
    };

    const refreshToken = isOAuth && model.providerId && model.authRef
      ? (rejectedAccessToken: string) => resolveModelApiKey(
          model,
          options.apiKey,
          rejectedAccessToken,
        )
      : undefined;

    plog(() =>
      `anthropic-passthrough → ${messagesUrl} oauth=${isOAuth} stream=${clientWantsStream} `
      + `native-identity=suppressed(${suppression.reason}) client-beta=${clientBeta.length} `
      + `capability-beta=${resolveCapabilityBetaTokens({ ...capability, url: messagesUrl, body: forwardBody }).join('|') || 'none'}`,
    );
    await relayAnthropicMessages(res, messagesUrl, forwardBody, apiKey, clientWantsStream, {
      authType,
      log: message => plog(message),
      extraHeaders: model.headers,
      capability,
      refreshToken,
      onTokenRefreshed: refreshed => { model.apiKey = refreshed; },
      // Echo the exact requested id when it differs from the upstream id, so
      // clients that key context windows on the response model still resolve.
      responseModelOverride:
        typeof body.model === 'string' && body.model !== upstreamModelId(model)
          ? body.model
          : undefined,
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            requestId,
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
    });
    return;
  }

  if (model.modelFormat === 'openai') {
    if (!isSdkMigratedNpm(model.npm)) {
      sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
      return;
    }
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    auditInference(options, {
      requestId,
      modelId: body.model,
      effort: anthropicEffortFromRequest(body as AnthropicRequest) ?? model.defaultEffort,
      claudeSessionId,
      // Use the adapter's route predicate and resolver so this records the same
      // pre-dispatch request intent. It does not prove SDK serialization.
      serviceTier: isOpenAiOAuthRoute(model) ? oauthServiceTier() : undefined,
      provider: inferenceProvider(model),
      route: 'translated',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    const npmMaxTools = maxToolsForNpm(model.npm);
    const toolCount = Array.isArray((body as Record<string, unknown>).tools) ? ((body as Record<string, unknown>).tools as unknown[]).length : 0;
    if (npmMaxTools !== undefined && toolCount > npmMaxTools) {
      plog(`tools truncated: ${toolCount} → ${npmMaxTools} (provider limit)`);
    }
    const openAiOAuth = isOpenAiOAuthRoute(model);
    const params = sdkTranslateRequest(body as unknown as AnthropicRequest, model.npm!, {
      defaultEffort: anthropicEffortFromRequest(body as AnthropicRequest) ? undefined : model.defaultEffort,
      openAiOAuth,
      claudeSessionId,
      effortPolicy: options.effortPolicy,
      reasoningMetadata: {
        providerId: model.providerId,
        apiBaseUrl: model.apiBaseUrl,
        supportedParameters: model.supportedParameters,
        reasoning: model.reasoning,
        interleavedReasoningField: model.interleavedReasoningField,
        compatibility: model.compatibility,
        effortProfile: model.effortProfile,
        upstreamModelId: upstreamModelId(model),
      },
      maxTools: npmMaxTools,
    });
    const clientWantsStream = Boolean(body.stream);
    // Use the display name in the response model field when masking is on — Claude
    // Desktop shows the response model field in its status bar chip, so this surfaces
    // human-readable names ("Grok 4.3 (xAI)") instead of the reversed gateway IDs.
    const responseModelId = getResponseModelId(body.model, model, options);

    plog(() => `sdk npm=${model.npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

    let sdkAttempt = 0;
    for (;;) {
      try {
        const languageModel = await getOrInitLanguageModel(
          modelCache,
          model,
          model.npm!,
          model.apiBaseUrl,
          apiKey,
          options.webSocketDiagnosticsLogPath,
        );
        if (clientWantsStream) {
          const writeStreamChunk = (chunk: string) => {
            if (!res.headersSent) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
              });
            }
            res.write(chunk);
          };
          await withResponsesWebSocketDiagnosticContext(
            { requestId, claudeSessionId },
            () => streamAnthropicResponse(languageModel, params, responseModelId, writeStreamChunk, undefined, {
              initialInputTokens: estimateAnthropicInputTokens(body),
            }),
          );
          if (!res.headersSent) writeStreamChunk('');
          res.end();
        } else {
          // ChatGPT/Codex OAuth routes only ever answer as SSE (the WebSocket fetch
          // returns text/event-stream unconditionally), so stream internally and
          // collect the result instead of issuing a non-streaming SDK request.
          const anthropicResponse = await withResponsesWebSocketDiagnosticContext(
            { requestId, claudeSessionId },
            () => generateAnthropicResponse(languageModel, params, responseModelId, { forceStream: openAiOAuth }),
          );
          sendJson(res, 200, anthropicResponse);
        }
        break;
      } catch (err) {
        const message = formatUpstreamError(err);
        const details = sdkUpstreamErrorDetails(err);
        const candidateStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
        const replacement = await resolveOAuthRetryReplacement(
          openAiOAuth,
          candidateStatus,
          sdkAttempt,
          res.headersSent,
          apiKey,
          rejectedAccessToken => resolveModelApiKey(model, options.apiKey, rejectedAccessToken),
        );
        if (replacement) {
          apiKey = replacement;
          sdkAttempt += 1;
          plog('sdk oauth credential replaced after 401; retrying once');
          continue;
        }
        const { statusCode: status, retryAfterSeconds } = auditSdkError(options, body.model, model, err, message);
        const contextLengthExceeded = status === 400
          && isContextLengthExceededError(err, message);
        const clientMessage = contextLengthExceeded
          ? anthropicPromptTooLongMessage(
              body,
              resolveContextWindow(upstreamModelId(model), model.contextWindow),
            )
          : message;
        plog(`sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}`);
        if (!res.headersSent) {
          if (contextLengthExceeded) {
            sendJson(res, 400, {
              type: 'error',
              error: { type: 'invalid_request_error', message: clientMessage },
              request_id: requestId,
            });
          } else {
            if (retryAfterSeconds !== undefined) res.setHeader('retry-after', String(retryAfterSeconds));
            sendJson(res, status === 500 ? 502 : status, { error: { message: clientMessage } });
          }
        } else {
          const errorType = anthropicErrorType(status);
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: { type: errorType, message: clientMessage },
            ...(contextLengthExceeded ? { request_id: requestId } : {}),
          })}\n\n`);
          res.end();
        }
        break;
      }
    }
    return;
  }

  sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
}

/**
 * `POST /anthropic/v1/messages/count_tokens`.
 *
 * Claude Code preflights its token accounting here, so the gateway has to
 * answer it on every launch mode that points ANTHROPIC_BASE_URL at this server
 * (`clodex server --endpoint`, the clodex-claude wrapper's endpoint gateway).
 * The routing rule is the one the adapter proxy already applies in
 * `src/proxy.ts`: speaking the Messages API is not the same question as
 * implementing count_tokens. A translated (SDK) model has no such endpoint at
 * all, and an Anthropic-format model whose upstream documents none is marked
 * with an explicit `supportsCountTokens: false`. Both answer from the shared
 * local estimator. An unset or `true` capability keeps forwarding, so a custom
 * Anthropic-compatible endpoint that does implement it is unaffected.
 */
async function handleAnthropicCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options, body.model);
  if (!model) {
    plog(`model not found: ${body.model}`);
    return;
  }

  // Keep the sibling messages route's format contract: a catalog entry this
  // server cannot serve must not be answered with a token count either.
  if (model.modelFormat !== 'anthropic' && model.modelFormat !== 'openai') {
    sendJson(res, 400, { error: { message: `Unsupported model format: ${model.modelFormat}` } });
    return;
  }

  if (model.modelFormat !== 'anthropic' || model.compatibility?.supportsCountTokens === false) {
    const inputTokens = estimateAnthropicInputTokens(body);
    plog(() => `token-count: local estimate model=${body.model} input_tokens=${inputTokens}`);
    res.setHeader('x-relay-token-count-source', 'local-estimate');
    sendJson(res, 200, { input_tokens: inputTokens });
    return;
  }

  if (model.baseUrl && !/^https?:\/\//i.test(model.baseUrl)) {
    sendJson(res, 400, { error: { message: `Invalid provider baseUrl: must be http:// or https://` } });
    return;
  }
  if (!model.baseUrl) {
    sendJson(res, 400, { error: { message: `Model ${model.id} has no Anthropic baseUrl configured` } });
    return;
  }

  let apiKey: string;
  try {
    apiKey = await resolveModelApiKey(model, options.apiKey);
  } catch (err) {
    sendJson(res, 401, {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }

  const authType = model.authType ?? 'api';
  const isOAuth = authType === 'oauth';
  const forwardBody: Record<string, unknown> = { ...body, model: upstreamModelId(model) };
  // Same contract as the Messages path: the client's beta is non-authoritative
  // context, and the relay emits what the provider configured plus whatever this
  // exact count_tokens request earns. A count is beta-gated the same way the
  // message it precedes is, so omitting it here would make the count disagree
  // with the request it is sizing.
  const clientBeta = normalizeBetaTokens(req.headers['anthropic-beta']);
  const suppression = resolveNativeIdentitySuppression(model.baseUrl);
  const capability = {
    clientBeta,
    requestedModelId: typeof body.model === 'string' ? body.model : undefined,
    advertisedModelId: model.id,
    advertisedContextWindow: model.contextWindow,
  };
  const refreshToken = isOAuth && model.providerId && model.authRef
    ? (rejectedAccessToken: string) => resolveModelApiKey(
        model,
        options.apiKey,
        rejectedAccessToken,
      )
    : undefined;

  const countTokensUrl = `${model.baseUrl}/v1/messages/count_tokens`;
  plog(() =>
    `anthropic-count-tokens → ${countTokensUrl} oauth=${isOAuth} `
    + `native-identity=suppressed(${suppression.reason}) client-beta=${clientBeta.length} `
    + `capability-beta=${resolveCapabilityBetaTokens({ ...capability, url: countTokensUrl, body: forwardBody }).join('|') || 'none'}`,
  );
  await relayAnthropicMessages(res, countTokensUrl, forwardBody, apiKey, false, {
    authType,
    log: message => plog(message),
    extraHeaders: model.headers,
    capability,
    refreshToken,
    onTokenRefreshed: refreshed => { model.apiKey = refreshed; },
  });
}

/**
 * Apply the global effort policy to a body about to be forwarded directly.
 *
 * Two spellings can arrive here. A client speaking clodex's global vocabulary
 * gets its level resolved against the model's executable ladder and rewritten to
 * the resolved level, which the reviewed wire map then translates exactly as it
 * does on the SDK path. A client that already wrote the upstream's own value is
 * left alone: the generator guarantees a one-to-one mapping, so recognising that
 * value is unambiguous, and re-resolving it would translate the request twice.
 */
function applyDirectEffortPolicy(
  body: JsonBody,
  model: ServerModelInfo,
  policy: UnsupportedEffortPolicy | undefined,
): JsonBody {
  const profile = model.effortProfile;
  if (!profile) return body;
  const requested = openAiEffort(body);
  if (requested !== undefined && nativeEffortLevel(profile, requested) !== undefined) return body;

  const resolution = resolveRequestEffort(
    requested,
    profile,
    policy ?? DEFAULT_UNSUPPORTED_EFFORT_POLICY,
  );
  if (resolution === undefined) return body;
  const next: JsonBody = { ...body };
  // `reasoning.effort` is the other accepted spelling; both are dropped so the
  // resolved decision cannot be contradicted by a leftover field.
  delete next.reasoning_effort;
  if (next.reasoning && typeof next.reasoning === 'object' && !Array.isArray(next.reasoning)) {
    const { effort: _effort, ...rest } = next.reasoning as Record<string, unknown>;
    if (Object.keys(rest).length > 0) next.reasoning = rest;
    else delete next.reasoning;
  }
  if (resolution.resolved !== undefined) next.reasoning_effort = resolution.resolved;
  return next;
}

async function handleOpenAIChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServerOptions,
  modelCache: LanguageModelCache,
  plog: PLog,
): Promise<void> {
  const body = await readJson(req);
  if (!body) {
    sendJson(res, 400, { error: { message: 'Invalid JSON body' } });
    return;
  }

  const model = lookupModel(res, options, body.model);
  if (!model) return;

  if (supportsDirectOpenAIChatCompletions(model)) {
    if (model.completionsUrl && !/^https?:\/\//i.test(model.completionsUrl)) {
      sendJson(res, 400, { error: { message: `Invalid provider completionsUrl: must be http:// or https://` } });
      return;
    }
    if (!model.completionsUrl) {
      sendJson(res, 400, { error: { message: `Model ${model.id} has no completionsUrl configured` } });
      return;
    }
    const completionsUrl = model.completionsUrl;
    let apiKey: string;
    try {
      apiKey = await resolveModelApiKey(model, options.apiKey);
    } catch (err) {
      sendJson(res, 401, {
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      return;
    }
    // Resolve the global effort at this boundary, then let the SAME wire map the
    // SDK path uses do the translation. Both paths therefore reach the upstream
    // with identical bytes for the same requested level.
    let policyBody: JsonBody;
    try {
      policyBody = applyDirectEffortPolicy(body, model, options.effortPolicy);
    } catch (err) {
      if (!(err instanceof EffortResolutionError)) throw err;
      sendJson(res, err.statusCode, { error: { message: err.message } });
      return;
    }
    // The client may have addressed the model via a gateway alias or saved
    // short alias — the upstream API only knows its own wire id.
    const compatibleBody = model.compatibility
      ? transformOpenAiCompatibleRequestBody(policyBody, model.compatibility)
      : policyBody;
    const forwardBody = compatibleBody.model === upstreamModelId(model)
      ? compatibleBody
      : { ...compatibleBody, model: upstreamModelId(model) };
    auditInference(options, {
      modelId: body.model,
      effort: openAiEffort(body),
      provider: inferenceProvider(model),
      route: 'passthrough',
      requestPreview: getLatestMessagePreview(body.messages, body.system),
    });
    const isOAuth = model.authType === 'oauth';
    const refreshToken = isOAuth && model.providerId && model.authRef
      ? (rejectedAccessToken: string) => resolveModelApiKey(
          model,
          options.apiKey,
          rejectedAccessToken,
        )
      : undefined;
    await relayAnthropicMessages(res, completionsUrl, forwardBody, apiKey, Boolean(body.stream), {
      authType: model.authType ?? 'api',
      extraHeaders: model.headers,
      refreshToken,
      onTokenRefreshed: refreshed => { model.apiKey = refreshed; },
      onUpstreamError: options.inferenceLogPath
        ? (statusCode, errorContent) => writeInferenceResponseErrorLog(options.inferenceLogPath!, {
            modelId: body.model,
            provider: inferenceProvider(model),
            route: 'passthrough',
            statusCode,
            errorContent,
          })
        : undefined,
    });
    return;
  }

  // SDK Translation Path
  const npm = model.npm || (model.modelFormat === 'anthropic' ? '@ai-sdk/anthropic' : undefined);
  if (!npm) {
    sendJson(res, 400, { error: { message: `No SDK provider for model: ${model.id}` } });
    return;
  }

  let apiKey: string;
  try {
    apiKey = await resolveModelApiKey(model, options.apiKey);
  } catch (err) {
    sendJson(res, 401, {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    return;
  }
  auditInference(options, {
    modelId: body.model,
    effort: openAiEffort(body),
    serviceTier: isOpenAiOAuthRoute(model) ? oauthServiceTier() : undefined,
    provider: inferenceProvider(model),
    route: 'translated',
    requestPreview: getLatestMessagePreview(body.messages, body.system),
  });
  const baseURL = model.modelFormat === 'anthropic' ? model.baseUrl : model.apiBaseUrl;
  const openAiOAuth = isOpenAiOAuthRoute(model);
  const params = translateOpenAiRequest(body as unknown as OpenAiRequest, { openAiOAuth });
  const clientWantsStream = Boolean(body.stream);
  const responseModelId = getResponseModelId(body.model, model, options);

  plog(() => `sdk-openai npm=${npm} upstream=${upstreamModelId(model)} responseModel=${responseModelId} stream=${clientWantsStream}`);

  let sdkAttempt = 0;
  for (;;) {
    try {
      const languageModel = await getOrInitLanguageModel(
        modelCache,
        model,
        npm,
        baseURL,
        apiKey,
      );
      if (clientWantsStream) {
        const writeStreamChunk = (chunk: string) => {
          if (!res.headersSent) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
          }
          res.write(chunk);
        };
        await streamOpenAiResponse(languageModel, params, responseModelId, writeStreamChunk);
        if (!res.headersSent) writeStreamChunk('');
        res.end();
      } else {
        // ChatGPT/Codex OAuth routes only ever answer as SSE (the WebSocket fetch
        // returns text/event-stream unconditionally), so stream internally and
        // collect the result instead of issuing a non-streaming SDK request.
        const response = await generateOpenAiResponse(languageModel, params, responseModelId, { forceStream: openAiOAuth });
        sendJson(res, 200, response);
      }
      break;
    } catch (err) {
      const message = formatUpstreamError(err);
      const details = sdkUpstreamErrorDetails(err);
      const candidateStatus = details?.statusCode ?? upstreamHttpStatus(err, message);
      const replacement = await resolveOAuthRetryReplacement(
        openAiOAuth,
        candidateStatus,
        sdkAttempt,
        res.headersSent,
        apiKey,
        rejectedAccessToken => resolveModelApiKey(model, options.apiKey, rejectedAccessToken),
      );
      if (replacement) {
        apiKey = replacement;
        sdkAttempt += 1;
        plog('sdk oauth credential replaced after 401; retrying once');
        continue;
      }
      const { statusCode: status, retryAfterSeconds } = auditSdkError(options, body.model, model, err, message);
      plog(`sdk error npm=${model.npm} upstream=${upstreamModelId(model)}: ${message}`);
      if (!res.headersSent) {
        if (retryAfterSeconds !== undefined) res.setHeader('retry-after', String(retryAfterSeconds));
        sendJson(res, status === 500 ? 502 : status, { error: { message } });
      } else {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error', code: status } })}\n\n`);
        res.end();
      }
      break;
    }
  }
}

function lookupModel(res: ServerResponse, options: ServerOptions, modelId: unknown): ServerModelInfo | null {
  if (typeof modelId !== 'string') {
    sendJson(res, 400, { error: { message: 'Request body must include a model string' } });
    return null;
  }

  const model = options.catalog.get(modelId);
  if (!model) {
    const rejection = options.modelAliasRejections?.find(candidate => (
      modelAliasMatchesStoredName(candidate.alias, modelId)
    ));
    const message = rejection === undefined
      ? `Unknown model: ${modelId}`
      : routeUnavailableMessage(modelId, describeModelAliasRejection(rejection.reason));
    sendJson(res, 400, { error: { message } });
    return null;
  }

  return model;
}

async function getOrInitLanguageModel(
  modelCache: LanguageModelCache,
  model: ServerModelInfo,
  npm: string,
  baseURL: string | undefined,
  apiKey: string,
  webSocketDiagnosticsLogPath?: string,
): Promise<LanguageModel> {
  const cacheKey = [
    model.providerId ?? model.sourceBackend,
    model.id,
    upstreamModelId(model),
    npm,
    baseURL ?? '',
  ].join('\x1f');
  let cached = modelCache.get(cacheKey);
  if (!cached || cached.apiKey !== apiKey) {
    const languageModel = await createLanguageModel({
      npm,
      modelId: upstreamModelId(model),
      apiKey,
      baseURL,
      providerId: model.providerId ?? model.sourceBackend,
      authType: model.authType,
      oauthAccountId: model.oauthAccountId,
      headers: model.headers,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      compatibility: model.compatibility,
      onWebSocketDiagnostic: webSocketDiagnosticsLogPath
        ? event => writeWebSocketDiagnosticLog(webSocketDiagnosticsLogPath, event)
        : undefined,
    });
    cached = { apiKey, languageModel };
    modelCache.set(cacheKey, cached);
  }
  return cached.languageModel;
}

function getResponseModelId(bodyModel: unknown, model: ServerModelInfo, options: ServerOptions): string {
  // Echo invariant: a saved short alias is echoed back verbatim even when
  // masking is on — Claude Code resolves context windows from the response
  // `model` field but preflights with the request alias, so rewriting it here
  // would break auto-compaction (see CLAUDE.md).
  if (typeof bodyModel === 'string' && options.aliasNames?.has(bodyModel)) return bodyModel;
  return options.gateway?.maskGatewayIds
    ? gatewayDisplayName(model, options.gateway)
    : (typeof bodyModel === 'string' ? bodyModel : model.id);
}

async function readJson(req: IncomingMessage): Promise<JsonBody | null> {
  try {
    const raw = await readBody(req);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
}

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, sanitizeIncomingHeaderValue(item));
    } else if (value !== undefined) {
      headers.set(name, sanitizeIncomingHeaderValue(value));
    }
  }

  return new Request('http://localhost/', { headers });
}

/** HTTP headers cannot contain CR/LF — common when a multi-line secret is pasted into a client. */
function sanitizeIncomingHeaderValue(value: string): string {
  return value.replace(/\r?\n/g, ' ').trim();
}
