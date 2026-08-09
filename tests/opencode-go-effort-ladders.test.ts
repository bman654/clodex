import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildOpenCodeGoModels } from '../src/data/opencode-go-models.js';

/**
 * The updater's feed-vs-map cross-check, exercised directly.
 *
 * `assertEffortLadders` lives in the generator script, which is plain ESM with
 * no exports and a network call in `main()`. It is lifted out by source slice
 * rather than imported so the check is covered without running the updater —
 * and so a rename or deletion of it fails here rather than silently removing
 * the guard.
 */
async function loadChecker(): Promise<(
  supported: unknown[],
  devModels: Record<string, unknown>,
) => { errors: string[]; notes: string[] }> {
  const source = await readFile('scripts/update-opencode-go-models.mjs', 'utf8');
  const start = source.indexOf('function assertEffortLadders');
  const end = source.indexOf('async function fetchJson');
  expect(start, 'assertEffortLadders missing from the updater').toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return new Function(`${source.slice(start, end)}; return assertEffortLadders;`)() as never;
}

const effortFeed = (values: string[]) => ({ reasoning_options: [{ type: 'effort', values }] });
const toggleFeed = () => ({ reasoning_options: [{ type: 'toggle' }, { type: 'budget_tokens' }] });

describe('updater effort-ladder cross-check', () => {
  it('fails a map that sends an effort the gateway does not publish', async () => {
    // The concrete mistake this exists to stop: Z.ai documents seven levels for
    // GLM-5.2 and Moonshot three for K3, but models.dev — the feed OpenCode
    // itself routes from — publishes high/max and max. Both were briefly
    // widened to the vendor ladders before that distinction was understood.
    const check = await loadChecker();
    const result = check(
      [{ id: 'glm-5.2', compatibility: { reasoningEffortMap: { low: 'low', high: 'high', max: 'max' } } }],
      { 'glm-5.2': effortFeed(['high', 'max']) },
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('maps to low');
    expect(result.errors[0]).toContain('high/max');
  });

  it('reports, without failing, a map narrower than the feed', async () => {
    // Sending fewer values than the gateway accepts is conservative, and
    // widening a ladder is exactly the change that wants live validation
    // rather than a script's confidence.
    const check = await loadChecker();
    const result = check(
      [{ id: 'deepseek-v4-flash', compatibility: { reasoningEffortMap: { high: 'high', max: 'max' } } }],
      { 'deepseek-v4-flash': effortFeed(['low', 'high', 'max']) },
    );
    expect(result.errors).toEqual([]);
    expect(result.notes[0]).toContain('feed also publishes low');
  });

  it('accepts an effort used as a toggle proxy, by shape rather than by id', async () => {
    const check = await loadChecker();
    const result = check(
      [{ id: 'qwen3.6-plus', compatibility: { thinkingFormat: 'qwen', reasoningEffortMap: { medium: 'high' } } }],
      { 'qwen3.6-plus': toggleFeed() },
    );
    expect(result.errors).toEqual([]);
    expect(result.notes[0]).toContain('toggle proxy');
  });

  it('does not excuse an unpublished effort without a thinkingFormat', async () => {
    // The exemption is for a value that drives the transform, not a blanket
    // pass for any model the feed describes as a toggle.
    const check = await loadChecker();
    const result = check(
      [{ id: 'someday', compatibility: { reasoningEffortMap: { medium: 'high' } } }],
      { someday: toggleFeed() },
    );
    expect(result.errors).toHaveLength(1);
  });

  it('notes a model with no local map, which cannot be cross-checked', async () => {
    const check = await loadChecker();
    const result = check([{ id: 'newcomer', compatibility: {} }], { newcomer: effortFeed(['high']) });
    expect(result.errors).toEqual([]);
    expect(result.notes[0]).toContain('cannot be cross-checked');
  });

  /**
   * What models.dev published for the OpenCode Go gateway when these maps were
   * last verified, recorded by hand.
   *
   * A snapshot, NOT derived from the catalog — deriving the expectation from
   * the thing under test is how the previous version of this assertion came to
   * be unfailable. Widening a ladder here is a deliberate two-line edit that
   * says "I checked the feed again", which is exactly the friction wanted: the
   * gateway's set and the upstream vendor's documented set are different
   * things, and two entries in this PR were widened to the vendor's before
   * that was understood.
   */
  const FEED_AS_VERIFIED: Record<string, string[] | 'toggle'> = {
    'deepseek-v4-flash': ['low', 'high', 'max'],
    'deepseek-v4-pro': ['high', 'max'],
    'glm-5.2': ['high', 'max'],
    'gpt-5.6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    hy3: ['none', 'low', 'high'],
    'kimi-k3': ['max'],
    'qwen3.6-plus': 'toggle',
  };

  it('every committed map stays within the ladder the gateway published', async () => {
    const check = await loadChecker();
    const models = buildOpenCodeGoModels();
    const feed = Object.fromEntries(
      Object.entries(FEED_AS_VERIFIED).map(([id, published]) =>
        [id, published === 'toggle' ? toggleFeed() : effortFeed(published)]),
    );
    // Any model without a snapshot entry is suppressed or unmapped; the
    // checker skips those, and a map appearing on one would surface as an
    // error rather than passing unnoticed.
    const result = check(models, feed);
    expect(result.errors).toEqual([]);
  });

  it('that assertion can actually fail', async () => {
    // Guards the guard. The previous version built its expectation from the
    // catalog, so widening glm-5.2 to a ladder the gateway does not publish
    // still passed 6/6 — pure false assurance.
    const check = await loadChecker();
    const widened = buildOpenCodeGoModels().map(model => model.id === 'glm-5.2'
      ? { ...model, compatibility: { ...model.compatibility, reasoningEffortMap: { low: 'low', high: 'high', max: 'max' } } }
      : model);
    const feed = Object.fromEntries(
      Object.entries(FEED_AS_VERIFIED).map(([id, published]) =>
        [id, published === 'toggle' ? toggleFeed() : effortFeed(published)]),
    );
    const errors = check(widened, feed).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('glm-5.2');
  });
});
