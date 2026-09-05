// Shared HTTP helpers for local proxy servers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as zlib from 'node:zlib';

/**
 * Decode a request body honoring Content-Encoding. Codex Desktop's built-in
 * `openai` provider zstd-compresses request bodies; without this they reach the
 * proxy as binary and JSON.parse fails with "Invalid JSON body".
 */
export function decodeRequestBody(raw: Buffer, encoding?: string | string[]): string {
  const enc = (Array.isArray(encoding) ? encoding.join(',') : encoding ?? '').toLowerCase().trim();
  if (!enc || enc === 'identity') return raw.toString();
  switch (enc) {
    case 'gzip':
    case 'x-gzip':
      return zlib.gunzipSync(raw).toString();
    case 'deflate':
      return zlib.inflateSync(raw).toString();
    case 'br':
      return zlib.brotliDecompressSync(raw).toString();
    case 'zstd':
      if (typeof zlib.zstdDecompressSync !== 'function') {
        throw new Error('zstd request encoding requires Node >= 22.15');
      }
      return zlib.zstdDecompressSync(raw).toString();
    default:
      // Unknown/unsupported encoding — best-effort raw decode.
      return raw.toString();
  }
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (c: Buffer) => {
      totalSize += c.length;
      if (totalSize > 50 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(decodeRequestBody(Buffer.concat(chunks), req.headers['content-encoding']));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function extractApiKey(req: IncomingMessage): string | null {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') return xApiKey;
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') return auth.replace(/^Bearer\s+/i, '').trim();
  return null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(json);
}

/**
 * Brand carried by the abort reason for a response that finished normally.
 * A registry symbol rather than a module-local one, so the brand still reads
 * correctly if this module is ever instantiated twice.
 */
const RESPONSE_COMPLETED: unique symbol = Symbol.for('clodex.responseCompleted');

/**
 * Abort reason for a response that reached the end of its life normally, as
 * opposed to a client that went away. Read it through `clientDisconnected`
 * rather than by identity.
 */
export class ResponseCompleted extends Error {
  readonly [RESPONSE_COMPLETED] = true;

  constructor() {
    super('Response completed');
    this.name = 'ResponseCompleted';
  }
}

/**
 * True only when the abort came from the client going away before its response
 * was complete. An end-of-life abort on a response that finished writing is
 * not a disconnect, so callers deciding whether to stay silent about an error
 * must ask this rather than reading `signal.aborted`.
 */
export function clientDisconnected(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason: unknown = signal.reason;
  return !(typeof reason === 'object' && reason !== null && RESPONSE_COMPLETED in reason);
}

/**
 * Request cancellation for a client that goes away before its response is
 * complete. Callers pass the returned signal to the upstream work they start,
 * so abandoned work can stop; whether it stops at once is up to the transport.
 *
 * The controller is aborted on every exit path, successful ones included: a
 * response only ever closes once, and at that point nothing the request started
 * has a reader left. Aborting unconditionally is defence in depth, not a fix
 * for a measured leak — no controller or response was found retained after a
 * forced GC without it. What it buys is that consumer abort listeners (undici's
 * per-request one, for example) run at a deterministic point instead of waiting
 * on the garbage collector.
 *
 * The two cases carry different reasons and must not be conflated:
 * `ResponseCompleted` for a normal finish, and the long-standing
 * `Client disconnected` error for a client that left. `clientDisconnected`
 * is the only correct way to tell them apart — `signal.aborted` is now true
 * for both.
 *
 * On a normal finish the abort always lands after the last byte: `res` emits
 * `close` only once it is finished or destroyed, and the relay paths that
 * return before their pipe drains still end `res` from that pipe. Measured over
 * 300 streaming and 300 non-streaming requests: byte-identical output, no
 * truncation, no unhandled error.
 *
 * An unfinished `close` is the only disconnect signal needed. Measured on Node
 * 24.14.1 and on the Node 22 engines floor, it fires in all three disconnect
 * shapes — before the response starts, after headers while a stream is in
 * flight, and while the request body is still uploading — and every observed
 * `IncomingMessage` `aborted` event arrived alongside one, microseconds apart.
 * The deprecated `aborted` event therefore adds no case here. That was
 * measured for this helper's callers, the inference and count_tokens handlers
 * in `src/proxy.ts` and `src/server/router.ts`, which read the whole request
 * body before starting any upstream work; a handler that streams its request
 * body upstream has not been characterised and should not assume it.
 */
export function watchClientDisconnect(res: ServerResponse): AbortController {
  const controller = new AbortController();
  res.once('close', () => {
    controller.abort(
      res.writableFinished ? new ResponseCompleted() : new Error('Client disconnected'),
    );
  });
  return controller;
}
