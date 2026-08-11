// PR 91 verification harnesses — clodex (github.com/bman654/clodex)
//
// Claim under test: PR 91 closes two blind spots in the #89 strip-rule canary.
//   (1) an omitted reasoning item hides a forked strip rule on the next call
//   (2) a gap on an older head goes silent behind a newer head's ordinary mismatch
//
// WHY THESE EXIST: the two tests PR 91 shipped both stage the function_call in the
// FIRST REQUEST'S INPUT, i.e. entry.requestInput. Production can never produce the
// bug there -- sanitizedCallArguments() is applied ONLY in expectedAssistantItems(),
// and continuationMatch()'s omitted_reasoning mode filters reasoning ONLY out of
// entry.expectedAssistant (and bails outright when none is there). These harnesses
// re-stage both scenarios the way production stages them: emitted by UPSTREAM via
// response.output_item.done, so they land in expectedAssistant.
//
// Harness 2 also injects a stepping `now` clock. Without it the two heads can share
// a lastUsedAt millisecond; the stable sort then makes the OLDER head the
// diagnosticEntry, which warns through the PRE-EXISTING path -- so the shipped test
// passes with the feature deleted.
//
// HOW TO RUN: paste both blocks into tests/responses-websocket.test.ts inside the
// `describe('createResponsesWebSocketFetch', ...)` block (they use its local helpers
// sessionPayload/lastSocket/emitTextResponse/readAll), then:
//   CLODEX_HOME=$(mktemp -d) pnpm vitest run tests/responses-websocket.test.ts -t HARNESS
//
// VERIFIED on head 86f6f9e (2026-08-07), both directions:
//   feature present -> HARNESS warned=true  / HARNESS2 warned=true
//   alignment reverted -> HARNESS warned=false
//   abandoned-head loop removed -> HARNESS2 warned=false
// Conclusion: PR 91's CODE is correct on the production path; only its tests are
// mis-staged. These print rather than assert, so they report instead of gating.

  it('HARNESS realistic omitted-reasoning fork staged in expectedAssistant', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      const diagnostics: ResponsesWebSocketDiagnosticEvent[] = [];
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'search it' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-harness-omit-real', onDiagnostic: e => diagnostics.push(e),
      });
      const first = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const socket = lastSocket();
      socket.emit('open');
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.created', response: { id: 'resp_h' },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc_real', summary: [] },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_h', name: 'Grep',
          arguments: '{"pattern":"x"}', status: 'completed' },
      })));
      socket.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed', response: { id: 'resp_h' },
      })));
      await readAll(first);

      const echoedCall = { type: 'function_call', call_id: 'call_h', name: 'Grep',
        arguments: '{"pattern":"x","glob":null}' };
      const out = { type: 'function_call_output', call_id: 'call_h', output: 'hits' };
      const second = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([...input, echoedCall, out])),
      });
      emitTextResponse(lastSocket(), 'resp_h_next', 'done');
      await readAll(second);

      const d = diagnostics.filter(e => e.event === 'ws_head_decision').at(-1)!;
      const heads = d.heads as { mismatch: Record<string, unknown> }[];
      process.stdout.write(`HARNESS decision=${d.decision}\n`);
      process.stdout.write(`HARNESS warned=${stderr.join('').includes('filler-strip rule')}\n`);
      process.stdout.write(`HARNESS mismatch=${JSON.stringify(heads[0]?.mismatch)}\n`);
    } finally {
      spy.mockRestore();
    }
  });

  it('HARNESS realistic multi-head gap on an older abandoned head', async () => {
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => { stderr.push(String(chunk)); return true; });
    try {
      let clock = 1_000_000;
      const input = [{ role: 'user', content: [{ type: 'input_text', text: 'search it' }] }];
      const wsFetch = createResponsesWebSocketFetch(WS_URL, undefined, {
        accountId: 'acct-harness-multi-real', now: () => (clock += 1000),
      });
      // Head A (older): upstream emits the call; the snapshot strips nothing.
      const a = await wsFetch('https://x', {
        method: 'POST', headers: {}, body: JSON.stringify(sessionPayload(input)),
      });
      const sa = lastSocket();
      sa.emit('open');
      sa.emit('message', Buffer.from(JSON.stringify({
        type: 'response.created', response: { id: 'resp_A' },
      })));
      sa.emit('message', Buffer.from(JSON.stringify({
        type: 'response.output_item.done', output_index: 0,
        item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'Grep',
          arguments: '{"pattern":"x"}', status: 'completed' },
      })));
      sa.emit('message', Buffer.from(JSON.stringify({
        type: 'response.completed', response: { id: 'resp_A' },
      })));
      await readAll(a);

      // Head B (newer): unrelated conversation, becomes the diagnostic entry.
      const b = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([
          { role: 'user', content: [{ type: 'input_text', text: 'something else' }] },
        ])),
      });
      lastSocket().emit('open');
      emitTextResponse(lastSocket(), 'resp_B', 'ok');
      await readAll(b);

      // Replay head A's conversation with the forked (filler-carrying) echo.
      const c = await wsFetch('https://x', {
        method: 'POST', headers: {},
        body: JSON.stringify(sessionPayload([
          ...input,
          { type: 'function_call', call_id: 'call_a', name: 'Grep',
            arguments: '{"pattern":"x","glob":null}' },
          { type: 'function_call_output', call_id: 'call_a', output: 'hits' },
        ])),
      });
      emitTextResponse(lastSocket(), 'resp_C', 'done');
      await readAll(c);
      process.stdout.write(`HARNESS2 warned=${stderr.join('').includes('filler-strip rule')}\n`);
    } finally {
      spy.mockRestore();
    }
  });
