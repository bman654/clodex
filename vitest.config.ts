import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scope collection to tests/. Without this, vitest's default glob is repo-wide: a review
    // worktree under .claude/worktrees/ gets its whole suite run, and the .agents -> .claude
    // symlink makes vitest walk that same tree a second time (91 files collected as 273).
    // It also means any stray *.test.ts anywhere in the repo would silently join CI.
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
