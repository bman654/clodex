import {
  resolveProviderCredential,
  resolveProviderCredentialOverrideState,
  type ProviderCredentialOverrideState,
} from './env.js';
import type { CompatibilityAgent } from './model-compatibility.js';
import { oauthAuthRef } from './registry/import-build.js';
import { loadRegistry } from './registry/io.js';
import { loadRegistryProviders, type LoadedRegistryProviders } from './registry/load.js';
import { isAnonymousProvider, projectSelectedOAuthAccount } from './registry/materialize.js';
import { OAUTH_ACCOUNT_ENV } from './oauth-account-selection.js';
import { getTemplateById } from './provider-templates.js';
import type { LocalProvider } from './types.js';
import type { ServerModelInfo } from './server/models.js';

export async function fetchProviderCatalog(
  opts?: { agent?: CompatibilityAgent },
): Promise<LoadedRegistryProviders> {
  const warn = (message: string) => console.warn(message);
  return loadRegistryProviders(warn, { ...opts, warn });
}

export function providersForPicker(providers: LocalProvider[]): LocalProvider[] {
  for (const p of providers) {
    p.models.sort((a, b) => {
      const nameA = a.name || a.id;
      const nameB = b.name || b.id;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base', numeric: true });
    });
  }

  return providers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
}

/** Resolve API key when provider.apiKey is empty (registry authRef or OAuth credential store). */
export async function resolveLocalProviderApiKey(provider: LocalProvider): Promise<string | null> {
  if (provider.authRef === 'none:anonymous' || provider.authType === 'none') return '';

  const direct = provider.apiKey?.trim();
  if (direct) return direct;

  const template = getTemplateById(provider.id);
  if (template?.apiKeyOptional || template?.anonymousFreeModels) {
    return '';
  }

  const reg = loadRegistry().providers.find(p => p.id === provider.id);
  const authRef = provider.authRef ?? reg?.authRef ?? oauthAuthRef(provider.id);
  return resolveProviderCredential(provider.id, authRef);
}

/** Human-readable auth line for `providers list` and provider detail. */
export function formatRegistryAuthLabel(
  provider: Pick<import('./registry/types.js').RegistryProvider, 'authRef' | 'authType'>,
): string {
  if (provider.authType === 'oauth' || provider.authRef.includes('oauth:provider:')) {
    return provider.authRef.startsWith('helper:') ? 'helper (OAuth)' : 'keychain (OAuth)';
  }
  if (isAnonymousProvider(provider)) return 'anonymous';
  if (provider.authType === 'none') {
    return 'gcloud / manual credentials';
  }
  if (provider.authRef.startsWith('keyring:')) {
    return 'keychain (API key)';
  }
  if (provider.authRef.startsWith('helper:')) {
    return 'helper (API key)';
  }
  if (provider.authRef.startsWith('env:')) {
    return provider.authRef;
  }
  return provider.authRef;
}

/** Row for providers list / hub. */
export interface ProviderDisplayEntry {
  id: string;
  name: string;
  modelCount: number;
  enabled: boolean;
  authLabel: string;
  inRegistry: boolean;
}

/**
 * How the provider's own credential is named wherever accounts are listed.
 *
 * Deliberately not "default": OAUTH_ACCOUNT_NAME_RE accepts `default` as a
 * real slot name, so any label a user could also type would be ambiguous with
 * a slot they created. The parenthesised form cannot collide.
 */
export const PROVIDER_DEFAULT_ACCOUNT_LABEL = '(provider default)';

/**
 * What a launch will ACTUALLY do with this provider's account selection.
 *
 * One home for the precedence, because the two surfaces that report it drifted
 * apart the moment they each computed it. It mirrors
 * `applySelectedOAuthAccount`, including its failure: a selector naming a slot
 * that does not exist makes the launch THROW, so `broken` is a real outcome
 * and not an edge case to paper over. Reporting such a selection as "active"
 * promises a launch that will not happen — which is how the detail hint came
 * to claim a missing account was in use.
 */
export type AccountSelection =
  /** Launches on the provider's own credential. */
  | { kind: 'default'; latentOrphan?: string; inactiveReason?: AccountSelectionInactiveReason; credentialOverride?: ProviderCredentialOverrideState }
  /** Launches on this named slot. */
  | { kind: 'slot'; name: string; fromEnvironment: boolean; latentOrphan?: string; inactiveReason?: AccountSelectionInactiveReason; credentialOverride?: ProviderCredentialOverrideState }
  /** Cannot be honoured: this selector names no such slot. */
  | { kind: 'broken'; name: string; fromEnvironment: boolean; latentOrphan?: string; inactiveReason?: AccountSelectionInactiveReason; credentialOverride?: ProviderCredentialOverrideState };

export type ActiveAccount =
  | AccountSelection
  /**
   * The provider-scoped key is the credential a launch will actually use.
   * `selection` remains explicit because saved/orphaned/dormant OAuth state is
   * still operationally important even though no account credential is live.
   */
  | {
      kind: 'credential-override';
      /** The override wins credential precedence, but runtime catalog loading fails closed. */
      credentialOverride: ProviderCredentialOverrideState;
      selection: AccountSelection;
      latentOrphan?: string;
      inactiveReason?: AccountSelectionInactiveReason;
    };

export type AccountSelectionInactiveReason = 'disabled' | 'non-oauth';

/**
 * `inactiveReason` — this does not describe a current OAuth launch outcome.
 *
 * A disabled OAuth provider carries the projected outcome it will have if it
 * is enabled, including the current environment override. A non-OAuth
 * provider carries only its stored registry state: enabling it cannot make an
 * OAuth selector apply, so callers must not describe it as merely disabled.
 */

/**
 * `latentOrphan` — a STORED selection that names no slot while something else
 * is currently winning, so it is not breaking anything yet.
 *
 * It has to be reported anyway. An environment override masks it for exactly
 * as long as the variable is set: unset it, or open a shell without it, and
 * every launch starts failing on a selection the listing had been calling
 * healthy the whole time.
 */

export function resolveActiveAccount(
  provider: Pick<
    import('./registry/types.js').RegistryProvider,
    'id' | 'authRef' | 'authAccounts' | 'activeAuthAccount' | 'authType' | 'enabled'
  >,
  env: NodeJS.ProcessEnv = process.env,
): ActiveAccount {
  const slots = provider.authAccounts ?? {};
  const has = (name: string) => Object.prototype.hasOwnProperty.call(slots, name);
  const stored = provider.activeAuthAccount?.trim();
  const override = env[OAUTH_ACCOUNT_ENV]?.trim().toLowerCase();

  const projectOAuthSelection = (environmentSelection: string | undefined): AccountSelection => {
    // Carried on whatever answer wins below: a stored selection that names no
    // slot is still broken while an override happens to be masking it. Only
    // carry a DIFFERENT stored name, or one failure is rendered twice.
    const latentOrphan = stored && !has(stored) && stored !== environmentSelection
      ? { latentOrphan: stored }
      : {};

    if (environmentSelection) {
      if (has(environmentSelection)) {
        return {
          kind: 'slot',
          name: environmentSelection,
          fromEnvironment: true,
          ...latentOrphan,
        };
      }
      // An environment selector only chooses among named slots. With no slot
      // table it is ignored, exactly as applySelectedOAuthAccount ignores it;
      // a stored selector remains independently authoritative and may fail.
      if (Object.keys(slots).length > 0) {
        return {
          kind: 'broken',
          name: environmentSelection,
          fromEnvironment: true,
          ...latentOrphan,
        };
      }
    }

    if (!stored) return { kind: 'default' };
    if (has(stored)) return { kind: 'slot', name: stored, fromEnvironment: false };
    return { kind: 'broken', name: stored, fromEnvironment: false };
  };

  // Non-OAuth providers never apply this selector, even when enabled. Ignore
  // the process-wide OAuth override and expose only stale/saved registry state.
  const selected = provider.authType !== 'oauth'
    ? { ...projectOAuthSelection(undefined), inactiveReason: 'non-oauth' as const }
    : provider.enabled
      ? projectOAuthSelection(override)
      : { ...projectOAuthSelection(override), inactiveReason: 'disabled' as const };

  // A missing OAuth slot fails in applySelectedOAuthAccount before credential
  // resolution. Preserve the redaction-safe override evidence, but never call
  // it effective or imply that it can rescue the broken selection.
  const effectiveAuthRef = provider.authType === 'oauth' && selected.kind === 'slot'
    ? slots[selected.name]?.authRef
    : provider.authRef;
  const credentialOverride = provider.authType !== 'none'
    && effectiveAuthRef !== 'none:anonymous'
    ? resolveProviderCredentialOverrideState(provider.id, env)
    : null;
  if (!credentialOverride) return selected;
  if (provider.authType === 'oauth' && selected.kind === 'broken') {
    return { ...selected, credentialOverride };
  }

  return {
    kind: 'credential-override',
    credentialOverride,
    selection: selected,
    ...(selected.latentOrphan ? { latentOrphan: selected.latentOrphan } : {}),
    ...(selected.inactiveReason ? { inactiveReason: selected.inactiveReason } : {}),
  };
}

export async function resolveProvidersForDisplay(): Promise<ProviderDisplayEntry[]> {
  const reg = loadRegistry();
  const entries: ProviderDisplayEntry[] = [];

  for (const provider of reg.providers) {
    const accountNames = Object.keys(provider.authAccounts ?? {}).sort();
    // Which identity a launch actually uses is the point of listing the slots
    // at all, so it is marked inline rather than left to be inferred from a
    // variable the operator has to remember setting.
    //
    // The provider's own credential is labelled "(provider default)", never
    // "default": `default` is a VALID slot name, so reusing it would render
    // two identical entries and mark both active, leaving the listing unable
    // to say which credential launches — the one question it exists to answer.
    //
    // The environment wins over the stored selection at launch, so it wins
    // here too; showing the stored one while a variable overrides it would
    // misreport the live identity in exactly the persistent shell this feature
    // is meant to make visible.
    const effective = resolveActiveAccount(provider);
    const selection = effective.kind === 'credential-override'
      ? effective.selection
      : effective;
    const credentialOverride = effective.credentialOverride;
    const credentialOverrideWins = effective.kind === 'credential-override';
    // `(active)` is a claim about what a launch will do now. Disabled OAuth
    // providers expose a projected selection instead; non-OAuth providers say
    // explicitly that the stale OAuth state is inactive.
    const active = !credentialOverrideWins && selection.kind === 'slot' && !selection.inactiveReason
      ? selection.name
      : undefined;
    const projected = !credentialOverrideWins
      && selection.kind === 'slot'
      && selection.inactiveReason === 'disabled'
      ? selection.name
      : undefined;
    const storedButInapplicable = selection.kind === 'slot' && selection.inactiveReason === 'non-oauth'
      ? selection.name
      : undefined;
    const accountOverrideApplies = selection.kind !== 'default' && selection.fromEnvironment;
    // A broken selection is the reason every launch for this provider fails,
    // so it is the LAST thing the listing should hide — and it is read from the
    // shared resolver rather than re-derived here, which is how the detail hint
    // drifted out of step in the first place.
    const broken = selection.kind === 'broken' ? selection : undefined;
    // Masked, not fixed. An override hides a broken stored selection only while
    // the variable is set; the listing has to say so, or it reads as healthy
    // right up until someone opens a shell without it.
    // Reported on a broken override too: the stored selection behind it is a
    // second, independent failure that survives fixing the variable.
    const latent = selection.latentOrphan;
    const label = (name: string): string => {
      if (name === active) {
        return accountOverrideApplies
          ? `${name} (active, from ${OAUTH_ACCOUNT_ENV})`
          : `${name} (active)`;
      }
      if (credentialOverrideWins && selection.kind === 'slot' && name === selection.name) {
        if (selection.inactiveReason === 'non-oauth') {
          return `${name} (stored; provider is not OAuth)`;
        }
        const selectedFrom = accountOverrideApplies ? `, from ${OAUTH_ACCOUNT_ENV}` : '';
        return selection.inactiveReason === 'disabled'
          ? `${name} (selected${selectedFrom}; provider disabled; ${credentialOverride!.variable} has no isolated model catalog)`
          : `${name} (selected${selectedFrom}; ${credentialOverride!.variable} configured; launch blocked — no isolated model catalog)`;
      }
      if (name === projected) {
        return accountOverrideApplies
          ? `${name} (selected, from ${OAUTH_ACCOUNT_ENV}; provider disabled)`
          : `${name} (selected; provider disabled)`;
      }
      if (name === storedButInapplicable) {
        return `${name} (stored; provider is not OAuth)`;
      }
      return name;
    };
    const defaultLabel = selection.kind !== 'default'
      ? PROVIDER_DEFAULT_ACCOUNT_LABEL
      : credentialOverrideWins
        ? selection.inactiveReason === 'disabled'
          ? `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (selected; provider disabled; ${credentialOverride!.variable} has no isolated model catalog)`
          : selection.inactiveReason === 'non-oauth'
            ? `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (OAuth selection inactive; provider is not OAuth)`
            : `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (selected; ${credentialOverride!.variable} configured; launch blocked — no isolated model catalog)`
        : selection.inactiveReason === 'disabled'
          ? `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (selected; provider disabled)`
          : selection.inactiveReason === 'non-oauth'
            ? `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (OAuth selection inactive; provider is not OAuth)`
            : `${PROVIDER_DEFAULT_ACCOUNT_LABEL} (active)`;
    const brokenConsequence = selection.inactiveReason === 'disabled'
      ? 'will fail if this provider is enabled'
      : selection.inactiveReason === 'non-oauth'
        ? 'ignored because this provider is not OAuth'
        : 'every launch fails';
    const accountList = [
      defaultLabel,
      ...accountNames.map(label),
      // An inactive account selection gets saved-state wording, not a current
      // OAuth outcome. A disabled provider is excluded from materialization;
      // a non-OAuth provider may launch, but never applies these selectors.
      ...(broken
        ? [`${broken.name} (${selection.inactiveReason === 'non-oauth' ? 'stored' : 'selected'}${broken.fromEnvironment ? ` via ${OAUTH_ACCOUNT_ENV}` : ''}, MISSING — `
          + `${brokenConsequence})`]
        : []),
      ...(latent
        ? [`${latent} (stored, MISSING — masked by ${OAUTH_ACCOUNT_ENV}; `
          + `${selection.inactiveReason === 'disabled' ? 'will fail if enabled without it' : 'launches fail without it'})`]
        : []),
    ].join(', ');
    const storedAuthLabel = formatRegistryAuthLabel(provider);
    const effectiveAuthLabel = !credentialOverride
      ? storedAuthLabel
      : credentialOverrideWins
        ? provider.enabled
          ? `${credentialOverride.variable} (configured provider override; launch blocked — no isolated model catalog; stored auth: ${storedAuthLabel})`
          : `${credentialOverride.variable} (configured provider override; no isolated model catalog; provider disabled; stored auth: ${storedAuthLabel})`
        : `${storedAuthLabel}; ${credentialOverride.variable} is configured but blocked by the invalid OAuth account selection`;
    const authLabel = accountNames.length || broken || latent
      ? `${effectiveAuthLabel}; accounts: ${accountList}`
      : effectiveAuthLabel;
    entries.push({
      id: provider.id,
      name: provider.name,
      // Model counts describe the identity this process would launch, not the
      // persisted account hidden behind CLODEX_OAUTH_ACCOUNT. A broken
      // selection has no safe catalog to advertise.
      modelCount: (() => {
        // A process-only provider credential has no account-owned discovery
        // cache. Runtime materialization fails closed for the same reason.
        if (credentialOverrideWins) return 0;
        try {
          return projectSelectedOAuthAccount(provider).modelsCache?.models.length ?? 0;
        } catch {
          return 0;
        }
      })(),
      enabled: provider.enabled,
      authLabel,
      inRegistry: true,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export function localProvidersToServerModels(localProviders: LocalProvider[]): ServerModelInfo[] {
  return localProviders.flatMap(provider =>
    provider.models.map(model => ({
      id: model.id,
      name: model.name,
      isFree: model.isFree ?? false,
      freeStatus: model.freeStatus,
      brand: model.brand,
      providerLabel: provider.name,
      providerId: provider.id,
      sourceBackend: provider.id,
      modelFormat: model.modelFormat,
      upstreamModelId: model.upstreamModelId,
      cost: model.cost,
      baseUrl: model.baseUrl,
      completionsUrl: model.completionsUrl,
      npm: model.modelFormat === 'openai' ? (model.npm || '@ai-sdk/openai-compatible') : model.npm,
      apiBaseUrl: model.apiBaseUrl,
      apiKey: provider.apiKey,
      authRef: provider.authRef,
      authType: provider.authType,
      oauthAccountId: provider.oauthAccountId,
      contextWindow: model.contextWindow,
      supportedParameters: model.supportedParameters,
      reasoning: model.reasoning,
      interleavedReasoningField: model.interleavedReasoningField,
      useResponsesLite: model.useResponsesLite,
      preferWebSockets: model.preferWebSockets,
      compatibility: model.compatibility,
      headers: provider.headers,
      providerData: provider.providerData,
    }))
  );
}
