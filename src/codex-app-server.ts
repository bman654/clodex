import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';

export interface JsonRpcError {
  code?: number;
  message: string;
  data?: unknown;
}

export interface CodexAppServerOptions {
  /** Defaults to the `codex` executable resolved from PATH. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Minimal v2 app-server client used by the experimental native-compaction path.
 *
 * This intentionally speaks the documented JSON-RPC stdio protocol instead of
 * importing Codex internals. The child process is owned by this object and is
 * never shared with the user's interactive Codex or Claude process.
 */
export class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: Interface;
  private readonly timeoutMs: number;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications = new Map<string, Array<(params: unknown) => void>>();

  private constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on('line', line => this.handleLine(line));
    child.on('error', error => this.failAll(error));
    child.on('exit', (code, signal) => {
      this.failAll(new Error(`Codex app-server exited (${code ?? 'null'}${signal ? `, ${signal}` : ''})`));
    });
  }

  static start(options: CodexAppServerOptions = {}): CodexAppServerClient {
    const child = spawn(options.command ?? 'codex', options.args ?? ['app-server', '--stdio'], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new CodexAppServerClient(child, options.requestTimeoutMs ?? 30_000);
  }

  async initialize(): Promise<unknown> {
    return this.request('initialize', {
      clientInfo: {
        name: 'clodex-native-compaction',
        title: 'clodex native compaction bridge',
        version: '0.1.0',
      },
    });
  }

  async startThread(params: Record<string, unknown> = {}): Promise<unknown> {
    return this.request('thread/start', params);
  }

  async injectItems(threadId: string, items: unknown[]): Promise<unknown> {
    return this.request('thread/inject_items', { threadId, items });
  }

  async compactThread(threadId: string): Promise<unknown> {
    return this.request('thread/compact/start', { threadId });
  }

  async readThread(threadId: string, includeTurns = true): Promise<unknown> {
    return this.request('thread/read', { threadId, includeTurns });
  }

  /** Wait for the v2 completion notification emitted after native compaction. */
  waitForCompaction(threadId: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    return this.waitForNotification('thread/compacted', params =>
      isRecord(params) && params.threadId === threadId,
      timeoutMs,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.kill();
    this.failAll(new Error('Codex app-server client closed'));
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed || !this.child.stdin.writable) {
      return Promise.reject(new Error('Codex app-server client is closed'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server method ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  private waitForNotification(
    method: string,
    predicate: (params: unknown) => boolean,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for Codex notification ${method}`)), timeoutMs);
      const handlers = this.notifications.get(method) ?? [];
      handlers.push(params => {
        if (!predicate(params)) return;
        clearTimeout(timer);
        resolve(params);
      });
      this.notifications.set(method, handlers);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code ?? 'unknown'})`));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const handler of this.notifications.get(message.method) ?? []) handler(message.params);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
