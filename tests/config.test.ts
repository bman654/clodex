import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearSavedServerPassword,
  getAppPathOverride,
  getSavedServerPassword,
  getServerListenMode,
  loadPreferences,
  recordLaunchFolder,
  resolveBridgeMode,
  savePreferences,
  setAppPathOverride,
  setSavedServerPassword,
  setServerListenMode,
} from '../src/config.js';
import {
  getAppHome,
  getConfigPath,
  getLegacyAppHome,
  resetLegacyMigrationForTests,
} from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-test-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
  process.env['CLODEX_HOME'] = join(tempHome, 'app-home');
  resetLegacyMigrationForTests();
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['CLODEX_HOME'];
  resetLegacyMigrationForTests();
});

describe('app paths', () => {
  it('uses CLODEX_HOME when set', () => {
    process.env['CLODEX_HOME'] = join(tempHome, 'custom-home');

    expect(getAppHome()).toBe(join(tempHome, 'custom-home'));
  });

  it('defaults to a .clodex folder under the user home', () => {
    expect(getAppHome({ HOME: tempHome })).toBe(join(tempHome, '.clodex'));
  });

  it('stores config.json inside the app home', () => {
    process.env['CLODEX_HOME'] = join(tempHome, 'app');

    expect(getConfigPath()).toBe(join(tempHome, 'app', 'config.json'));
  });
});

describe('dotfolder config', () => {
  it('writes preferences to config.json in the app home', () => {
    savePreferences({ lastProvider: 'openai-oauth', lastModel: 'gpt-5.6-sol' });

    expect(loadPreferences()).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8'))).toMatchObject({
      lastProvider: 'openai-oauth',
      lastModel: 'gpt-5.6-sol',
    });
  });

  it('saves favorites and aliases', () => {
    savePreferences({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });

    expect(loadPreferences()).toMatchObject({
      favoriteModels: [{ providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
      modelAliases: [{ name: 'sol', providerId: 'openai-oauth', modelId: 'gpt-5.6-sol' }],
    });
  });

  it('saves and clears app path overrides', () => {
    setAppPathOverride('claude', '/tmp/custom-claude');

    expect(getAppPathOverride('claude')).toBe('/tmp/custom-claude');
    expect(loadPreferences().appPathOverrides).toEqual({ claude: '/tmp/custom-claude' });

    setAppPathOverride('claude', null);

    expect(getAppPathOverride('claude')).toBeUndefined();
    expect(loadPreferences().appPathOverrides).toBeUndefined();
  });

  it('records recent launch folders with most recent first', () => {
    recordLaunchFolder('/Users/jbendavi/project-a');
    recordLaunchFolder('/Users/jbendavi/project-b');
    recordLaunchFolder('/Users/jbendavi/project-a');

    expect(loadPreferences().recentLaunchFolders).toEqual([
      '/Users/jbendavi/project-a',
      '/Users/jbendavi/project-b',
    ]);
  });

  it('returns null when no server password is saved', async () => {
    expect(await getSavedServerPassword()).toBeNull();
  });

  it('saves and clears a server password', async () => {
    await setSavedServerPassword('my-lan-password');
    expect(await getSavedServerPassword()).toBe('my-lan-password');

    await clearSavedServerPassword();
    expect(await getSavedServerPassword()).toBeNull();
  });

  it('saves server listen-mode preference', () => {
    expect(getServerListenMode()).toBe('local');

    setServerListenMode('network');
    expect(getServerListenMode()).toBe('network');

    setServerListenMode('local');
    expect(getServerListenMode()).toBe('local');
  });

  it('creates the app home lazily', () => {
    expect(existsSync(process.env['CLODEX_HOME']!)).toBe(false);

    savePreferences({ lastProvider: 'openai' });

    expect(existsSync(process.env['CLODEX_HOME']!)).toBe(true);
  });
});

describe('bridge-mode memory', () => {
  it('defaults both commands to endpoint mode', () => {
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');
  });

  it('persists an explicit mode as the new default per command', () => {
    expect(resolveBridgeMode('claude', 'proxy')).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    // server is remembered independently
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');

    expect(resolveBridgeMode('server', 'proxy')).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');

    expect(resolveBridgeMode('claude', 'endpoint')).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('does not persist when persist is false', () => {
    expect(resolveBridgeMode('claude', 'proxy', { persist: false })).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
  });
});

describe('legacy ~/.relay-ai migration', () => {
  it('copies config and auth state on first read when the clodex home is missing', () => {
    delete process.env['CLODEX_HOME'];
    const legacyHome = getLegacyAppHome({ HOME: tempHome });
    mkdirSync(join(legacyHome, 'http-proxy'), { recursive: true });
    writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({ lastModel: 'gpt-5.6-sol' }), 'utf8');
    writeFileSync(join(legacyHome, 'providers.json'), JSON.stringify({ schemaVersion: 1, providers: [] }), 'utf8');
    writeFileSync(join(legacyHome, 'http-proxy', 'ca.pem'), 'PEM', 'utf8');
    mkdirSync(join(legacyHome, 'logs'), { recursive: true });
    writeFileSync(join(legacyHome, 'logs', 'session.log'), 'log', 'utf8');
    resetLegacyMigrationForTests();

    expect(loadPreferences().lastModel).toBe('gpt-5.6-sol');
    const appHome = getAppHome({ HOME: tempHome });
    expect(existsSync(join(appHome, 'config.json'))).toBe(true);
    expect(existsSync(join(appHome, 'providers.json'))).toBe(true);
    expect(existsSync(join(appHome, 'http-proxy', 'ca.pem'))).toBe(true);
    // logs are session state, not config — never copied
    expect(existsSync(join(appHome, 'logs'))).toBe(false);
    // the legacy home is never modified
    expect(readFileSync(join(legacyHome, 'config.json'), 'utf8')).toContain('gpt-5.6-sol');
  });

  it('does not migrate when the clodex home already exists', () => {
    delete process.env['CLODEX_HOME'];
    const appHome = getAppHome({ HOME: tempHome });
    mkdirSync(appHome, { recursive: true });
    writeFileSync(join(appHome, 'config.json'), JSON.stringify({ lastModel: 'existing' }), 'utf8');

    const legacyHome = getLegacyAppHome({ HOME: tempHome });
    mkdirSync(legacyHome, { recursive: true });
    writeFileSync(join(legacyHome, 'config.json'), JSON.stringify({ lastModel: 'legacy' }), 'utf8');
    resetLegacyMigrationForTests();

    expect(loadPreferences().lastModel).toBe('existing');
  });
});
