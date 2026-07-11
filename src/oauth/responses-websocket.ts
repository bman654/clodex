// responses-websocket.ts — outbound WebSocket transport for OpenAI's Codex
// "Responses-Lite" protocol (wss://chatgpt.com/backend-api/codex/responses).
//
// Some ChatGPT Codex models (flagged by the backend with prefer_websockets,
// e.g. gpt-5.6-luna) are only served over a WebSocket Responses transport, not
// the HTTP Responses endpoint. This module returns a `fetch` implementation that
// the Vercel AI SDK's OpenAI provider uses transparently: the SDK still calls
// `fetch(url, init)` once per request, but instead of an HTTP POST we open one
// WebSocket per request, send the Responses payload as the first message, and
// stream the JSON event frames back as Server-Sent Events the SDK already parses.
//
// One socket per request → responses are never crossed between concurrent
// requests (e.g. Claude Code's parallel title-generation + main inference).

import type { FetchFunction } from '@ai-sdk/provider-utils';
import type { RawData, WebSocket as WsWebSocket } from 'ws';
import { CODEX_RESPONSES_WEBSOCKETS_BETA } from '../constants.js';

const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
// Responses event types after which the stream is complete and the socket closes.
const TERMINAL_EVENT_TYPES = new Set(['response.completed', 'response.failed', 'response.incomplete']);

/** Normalize the SDK's HeadersInit into a plain lowercased-key record for `ws`. */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
  } else {
    for (const [key, value] of Object.entries(headers)) out[key] = String(value);
  }
  return out;
}

function hasResponsesLiteHeader(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([k, v]) => k.toLowerCase() === RESPONSES_LITE_HEADER && v.toLowerCase() === 'true',
  );
}

/** Extract the request body as a string (the SDK sends a JSON string). */
function bodyToString(body: BodyInit | null | undefined): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body)).toString('utf8');
  return String(body);
}

/**
 * Apply the Responses-Lite request shape to the outgoing payload. These fields
 * are set on the wire (not via SDK providerOptions) so the transport fully owns
 * the Luna request shape. Adjust here if live traffic shows different field names.
 */
function applyResponsesLiteShape(payload: Record<string, unknown>): Record<string, unknown> {
  const reasoning = (payload.reasoning && typeof payload.reasoning === 'object')
    ? { ...(payload.reasoning as Record<string, unknown>) }
    : {};
  reasoning.context = 'all_turns';
  return {
    ...payload,
    reasoning,
    parallel_tool_calls: false,
    store: false,
  };
}

/**
 * Build a `fetch` that speaks the Codex Responses-Lite WebSocket protocol.
 * @param wsUrl e.g. wss://chatgpt.com/backend-api/codex/responses
 * @param log optional debug logger (wired to the proxy trace log under --trace)
 */
export function createResponsesWebSocketFetch(wsUrl: string, log?: (msg: string) => void): FetchFunction {
  const debug = (msg: string) => { try { log?.(`ws: ${msg}`); } catch { /* ignore */ } };
  return async (_input, init): Promise<Response> => {
    const { WebSocket } = await import('ws');

    const headers = toHeaderRecord(init?.headers);
    headers['OpenAI-Beta'] = CODEX_RESPONSES_WEBSOCKETS_BETA;
    debug(`connecting ${wsUrl} headers=[${Object.keys(headers).join(', ')}]`);

    // Parse the SDK-built Responses body and, when this is a Responses-Lite
    // model, fold in the transport-specific request fields.
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(bodyToString(init?.body)) as Record<string, unknown>;
    } catch {
      payload = {};
    }
    if (hasResponsesLiteHeader(headers)) {
      payload = applyResponsesLiteShape(payload);
    }
    // The Codex WS Responses protocol is internally tagged: the first (and only)
    // client message must be a `response.create` event carrying the Responses
    // body fields at the top level, alongside the type tag — not the raw body.
    // (See openai/codex `ResponsesWsRequest`, `#[serde(tag = "type")]`.)
    const outgoing = JSON.stringify({ type: 'response.create', ...payload });

    const encoder = new TextEncoder();
    let socket: WsWebSocket;
    let frameCount = 0;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
          try { socket.close(); } catch { /* ignore */ }
        };
        const fail = (message: string) => {
          if (closed) return;
          debug(`fail: ${message}`);
          // Surface as an SSE error event the SDK's responses parser understands.
          try {
            controller.enqueue(encoder.encode(
              `data: ${JSON.stringify({ type: 'error', error: { message } })}\n\n`,
            ));
          } catch { /* ignore */ }
          close();
        };

        socket = new WebSocket(wsUrl, { headers });

        socket.on('open', () => {
          debug(`open — sending ${outgoing.length}B payload`);
          socket.send(outgoing);
        });
        socket.on('unexpected-response', (_req, res) => {
          debug(`unexpected-response status=${res.statusCode}`);
        });

        socket.on('message', (data: RawData) => {
          const text = Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : data.toString('utf8');
          frameCount += 1;
          if (frameCount <= 3) debug(`frame#${frameCount}: ${text.slice(0, 200)}`);
          // Collapse any pretty-printed JSON onto a single SSE data line; if a
          // frame isn't JSON, forward it stripped of newlines rather than emit
          // an invalid multi-line SSE event.
          let event: unknown;
          try {
            event = JSON.parse(text);
          } catch {
            controller.enqueue(encoder.encode(`data: ${text.replace(/\r?\n/g, ' ')}\n\n`));
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          const type = (event as { type?: unknown }).type;
          if (typeof type === 'string' && TERMINAL_EVENT_TYPES.has(type)) {
            debug(`terminal event: ${type} (after ${frameCount} frames)`);
            close();
          }
        });

        socket.on('error', (err: Error) => fail(err.message));
        socket.on('close', (code: number, reason: Buffer) => {
          debug(`close code=${code} frames=${frameCount}${reason?.length ? ` reason=${reason.toString('utf8').slice(0, 200)}` : ''}`);
          if (closed) return;
          if (code === 1000 || code === 1005) { close(); return; }
          fail(`WebSocket closed (${code})${reason?.length ? `: ${reason.toString('utf8')}` : ''}`);
        });

        const signal = init?.signal;
        if (signal) {
          if (signal.aborted) { close(); return; }
          signal.addEventListener('abort', close, { once: true });
        }
      },
      cancel() {
        try { socket?.close(); } catch { /* ignore */ }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8' },
    });
  };
}
