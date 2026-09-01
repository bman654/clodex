// Minified stand-ins for the Claude Code bundle, carrying every anchor the patch transforms key
// on so they can be executed end to end.
//
// Shared rather than private to one test file: tests/probe-patch-sites.test.ts pins the canary
// probe's synthetic config and its list of expected patch sites against these same anchors, which
// is what stops a new or renamed PATCH site from reaching the hourly canary as a mystery failure
// on every platform at once.

/**
 * The Agent tool's `model` enum and its description, as Claude Code 2.1.242 spells them: the
 * description template no longer closes its `describe(` call directly, it is concatenated with a
 * conditional sentence first. PATCH 4's anchor used to require the closing paren and silently
 * stopped matching on that release.
 */
const ENUM_AND_DESCRIPTION =
  '.enum(["sonnet","opus","haiku","fable"]).optional().describe(`Optional model override for this '
  + 'agent. Defaults to inherit.`+(hint()?" Prefer the session model.":""))';

/**
 * The context-window resolver PATCH 7 keys on, as Claude Code 2.1.252 minified it. Its two
 * PARAMETER names are as minified — and as churn-prone — as every other identifier here:
 * 2.1.257 spelled the very same function `(e,n)`, and an anchor that required `(e,t)` failed on
 * all eight published builds at once. `contextResolver` re-spells it so a test can pin that.
 */
export const CONTEXT_RESOLVER =
  'function RS(e,t){let r=FAc();if(r!==void 0)return r;if(EHi(e,t))return Dve;return $Ac(e,t)}';

/** The same resolver with the two parameters renamed, as a later build's minifier may spell it. */
export function contextResolver(modelParam: string, windowParam: string): string {
  return `function RS(${modelParam},${windowParam}){let r=FAc();if(r!==void 0)return r;`
    + `if(EHi(${modelParam},${windowParam}))return Dve;return $Ac(${modelParam},${windowParam})}`;
}

export const CLAUDE_CORE_FIXTURE = [
  ENUM_AND_DESCRIPTION,
  'var KNOWN=["sonnet","opus","haiku","fable","opusplan"];',
  'function rz(x){switch(x){case"best":{return "opus"}default:return null}}',
  'function opts(e,t,r){let n=cur(),o=(n==="opus"||n==="sonnet")&&n!==r?[n,r]:[r];for(let i of o)Dlh(e,i,t);return e}',
  CONTEXT_RESOLVER,
  'function cwdOf(){let p=process.env.PWD;return p}',
  'function childEnv(){let e=extra(),t=Object.keys(e).length>0,n=Object.keys(e).length>0,s=flag(process.env.CLAUDE_CODE_REMOTE)?remote():{};let o=[process.env.CLAUDE_CODE_OAUTH_TOKEN,process.env.CLAUDE_CODE_SUBSCRIPTION_TYPE,process.env.CLAUDE_BG_PTY_AUTH,"OTEL_",process.env.CLAUDE_CODE_OTEL_DIAG_STDERR],u=["CLAUDE_CODE_OAUTH_TOKEN"];if(!t&&!n&&!o[0])return process.env;let v={...process.env,...e,...s};for(let k of u)delete v[k],delete v[`INPUT_${k}`];return v}function mcpAllow(){let e=process.env.CLAUDE_CODE_MCP_ALLOWLIST_ENV;return e}',
].join('\n');

export const CLAUDE_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return!1}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return!1}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return!1}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

export const CLAUDE_PROXY_EFFORT_FIXTURE = [
  CLAUDE_CORE_FIXTURE,
  'function OI(e){if(SNr(e))return!1;let t=Ede(e,"effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function I_e(e){if(SNr(e))return!1;let t=Ede(e,"xhigh_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function eqe(e){if(SNr(e))return!1;let t=Ede(e,"max_effort");if(t!==void 0)return t;return proxyMode(e)}',
  'function ait(e){return ww(lo(e))?.default_effort??"high"}',
].join('\n');

/**
 * The same bundle, code-split the way Claude Code 2.1.242 splits it: a small entry module that
 * imports its siblings, with the patch anchors spread across chunks that tweakcc's name-based read
 * never returns.
 *
 * Three things about the shape are deliberate, because a fixture without them lets real defects
 * through:
 *
 *  * The entry module is NOT at table index 0, so a plan that assumed the module tweakcc writes
 *    comes first in the table would still pass.
 *  * A non-JavaScript module sits BETWEEN two chunks, so a module's position in the blob table and
 *    its position in the bundle are different numbers. On every build shipped so far the assets
 *    happen to sort last, which makes the two accidentally equal.
 *  * That module's payload contains a patch anchor. Bun never executes it, so clodex must never
 *    patch it — vendored JavaScript (`mermaid.min.js`, `hljsBundle.generated.min.js`) is exactly
 *    this shape. Include it in the bundle and the anchor matches twice and the patch refuses.
 */
export const CLAUDE_SPLIT_MODULES = [
  {
    name: '/$bunfs/root/chunk-agent.js',
    contents: `export var agentTool=z${CLAUDE_CORE_FIXTURE.split('\n')[0]};`,
  },
  {
    name: '/$bunfs/root/vendored.min.js',
    loader: 5,
    contents: `var vendored=z${CLAUDE_CORE_FIXTURE.split('\n')[0]};`,
  },
  {
    name: '/$bunfs/root/chunk-aliases.js',
    contents: CLAUDE_CORE_FIXTURE.split('\n').slice(1, 3).join('\n'),
  },
  {
    name: '/$bunfs/root/cli',
    contents: 'import{agentTool}from"/$bunfs/root/chunk-agent.js";'
      + 'import{main}from"/$bunfs/root/chunk-runtime.js";main(agentTool);',
  },
  {
    name: '/$bunfs/root/image-processor.node',
    loader: 10,
    contents: 'native helper',
  },
  {
    // A real pre-split blob carries five of these ~2 KB loader-1 stubs beside the bundle, and they
    // now reach the transforms too. One is here so a near-miss in an auxiliary module is a shape
    // the suite has seen.
    name: '/$bunfs/root/audio-capture.js',
    contents: 'export default require("/$bunfs/root/audio-capture.node");'
      + 'var notTheEnum=["sonnet","opus"];',
  },
  {
    name: '/$bunfs/root/chunk-runtime.js',
    contents: [
      CLAUDE_CORE_FIXTURE.split('\n').slice(3).join('\n'),
      ...CLAUDE_FIXTURE.split('\n').slice(CLAUDE_CORE_FIXTURE.split('\n').length),
    ].join('\n'),
  },
];

/**
 * Table position of `/$bunfs/root/cli`: Bun's entry point, and — once the shim has renamed it —
 * the module tweakcc writes. Those are the same module on every real build.
 */
export const CLAUDE_SPLIT_ENTRY_ID = 3;

/** Table positions of the modules Bun executes as JavaScript. Sparse, because assets sit between. */
export const CLAUDE_SPLIT_JS_IDS = [0, 2, 3, 5, 6];
