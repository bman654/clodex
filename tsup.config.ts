import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts', 'src/claude-wrapper.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  minify: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: [
    '@napi-rs/keyring',
    'ws',
    /^@ai-sdk\//,
    'open',
    'undici',
    'https-proxy-agent',
    'tweakcc',
  ],
});
