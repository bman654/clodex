import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { getAppHome, getConfigPath } from '../src/paths.js';

let tempHome: string;
let previousHome: string | undefined;

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'clodex-test-'));
  previousHome = process.env['HOME'];
  process.env['HOME'] = tempHome;
  process.env['CLODEX_HOME'] = join(tempHome, 'app-home');
});

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  delete process.env['CLODEX_HOME'];
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
  it('defaults both commands to proxy mode when nothing is saved', () => {
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('never auto-persists an explicit mode flag', () => {
    expect(resolveBridgeMode('claude', 'endpoint')).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: false })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');
  });

  it('persists only with an explicit save gesture (--save-mode), per command', () => {
    expect(resolveBridgeMode('claude', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');
    // server is remembered independently — still the proxy default
    expect(resolveBridgeMode('server', undefined)).toBe('proxy');

    expect(resolveBridgeMode('server', 'endpoint', { persist: true })).toBe('endpoint');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');

    // saved default is overridable for one run without losing the saved value
    expect(resolveBridgeMode('claude', 'proxy')).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('endpoint');

    // and replaceable with another --save-mode
    expect(resolveBridgeMode('claude', 'proxy', { persist: true })).toBe('proxy');
    expect(resolveBridgeMode('claude', undefined)).toBe('proxy');
    expect(resolveBridgeMode('server', undefined)).toBe('endpoint');
  });
});
