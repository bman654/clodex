import WebSocket from 'ws';
import {
  CODEX_RESPONSES_LITE_VERSION,
  CODEX_RESPONSES_LITE_WS_URL,
  CODEX_RESPONSES_WEBSOCKETS_BETA,
} from '../src/constants.js';
import { extractOpenAiAccountId } from '../src/oauth/openai.js';
import { loadRegistryProviders } from '../src/registry/index.js';

interface Usage {
  inputTokens: number;
  cachedTokens: number;
}

if (process.env.CLODEX_LIVE_CACHE_BENCHMARK !== '1') {
  throw new Error('Set CLODEX_LIVE_CACHE_BENCHMARK=1 to authorize this live benchmark');
}

const provider = (await loadRegistryProviders()).find(candidate => (
  candidate.authType === 'oauth'
  && candidate.models.some(model => model.upstreamModelId === 'gpt-5.6-sol')
));
if (!provider?.apiKey) throw new Error('No usable OpenAI OAuth provider was found');
const accountId = extractOpenAiAccountId({ access_token: provider.apiKey })?.trim()
  || provider.oauthAccountId?.trim();
const headers = {
  Authorization: `Bearer ${provider.apiKey}`,
  ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  originator: 'clodex-cache-benchmark',
  version: CODEX_RESPONSES_LITE_VERSION,
  'x-openai-internal-codex-responses-lite': 'true',
  'OpenAI-Beta': CODEX_RESPONSES_WEBSOCKETS_BETA,
};

async function openSocket(): Promise<WebSocket> {
  const socket = new WebSocket(CODEX_RESPONSES_LITE_WS_URL, { headers });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

async function create(socket: WebSocket, payload: Record<string, unknown>): Promise<Usage> {
  return await new Promise<Usage>((resolve, reject) => {
    const cleanup = () => {
      socket.off('error', onError);
      socket.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      const type = typeof event.type === 'string' ? event.type : '';
      if (!['response.completed', 'response.failed', 'error'].includes(type)) return;
      cleanup();
      if (type !== 'response.completed') {
        reject(new Error(`Benchmark request failed: ${JSON.stringify(event)}`));
        return;
      }
      const response = event.response as Record<string, unknown>;
      const usage = response.usage as Record<string, unknown>;
      const details = usage.input_tokens_details as Record<string, unknown>;
      resolve({
        inputTokens: Number(usage.input_tokens ?? 0),
        cachedTokens: Number(details.cached_tokens ?? 0),
      });
    };
    socket.on('error', onError);
    socket.on('message', onMessage);
    socket.send(JSON.stringify({ type: 'response.create', ...payload }));
  });
}

const requests = 12;
const instructions = 'Stable synthetic prompt-cache benchmark prefix. '.repeat(450);
function payload(mode: string, index: number): Record<string, unknown> {
  return {
    model: 'gpt-5.6-sol',
    instructions,
    tools: [],
    parallel_tool_calls: false,
    reasoning: { effort: 'low', context: 'all_turns' },
    prompt_cache_key: `clodex-cache-benchmark-${mode}`,
    store: false,
    input: [{
      role: 'user',
      content: [{ type: 'input_text', text: `Divergent request ${index}. Reply only OK.` }],
    }],
  };
}

async function baseline(): Promise<Usage[]> {
  const samples: Usage[] = [];
  for (let index = 0; index < requests; index += 1) {
    const socket = await openSocket();
    samples.push(await create(socket, payload('fresh', index)));
    socket.close();
  }
  return samples;
}

async function pooled(): Promise<Usage[]> {
  const sockets = [await openSocket(), await openSocket()];
  const samples: Usage[] = [];
  for (let index = 0; index < requests; index += 1) {
    samples.push(await create(sockets[index % 2]!, payload('pooled', index)));
  }
  sockets.forEach(socket => socket.close());
  return samples;
}

function summary(samples: Usage[]) {
  const inputTokens = samples.reduce((sum, sample) => sum + sample.inputTokens, 0);
  const cachedTokens = samples.reduce((sum, sample) => sum + sample.cachedTokens, 0);
  return {
    requests: samples.length,
    cacheHitRequests: samples.filter(sample => sample.cachedTokens > 0).length,
    inputTokens,
    cachedTokens,
    cachedTokenRate: cachedTokens / inputTokens,
  };
}

const fresh = await baseline();
const warm = await pooled();
process.stdout.write(`${JSON.stringify({
  baseline: summary(fresh),
  pooled: summary(warm),
  samples: { baseline: fresh, pooled: warm },
}, null, 2)}\n`);
