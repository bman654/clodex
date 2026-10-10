/**
 * spawnSync options for a Node child that can end in process.exit().
 *
 * spawnSync blocks the vitest worker, so vitest's own timeout cannot fire while it waits. On Node 24
 * process.exit() can deadlock and never return (https://github.com/nodejs/node/issues/64274), and an
 * unbounded wait on such a child held CI's test job until GitHub cancelled it six hours later.
 * SIGKILL because a child stuck in process.exit() runs no JavaScript: a script that listens for
 * SIGTERM would leave that signal caught and unhandled.
 */
export const BOUNDED_NODE_CHILD = { timeout: 60_000, killSignal: 'SIGKILL' } as const;
