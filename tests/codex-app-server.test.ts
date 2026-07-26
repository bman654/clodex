import { describe, expect, it } from 'vitest';
import { CodexAppServerClient } from '../src/codex-app-server.js';

describe('CodexAppServerClient', () => {
  it('drives initialize, thread injection, native compaction, and completion', async () => {
    const script = [
      "const readline=require('readline');",
      "const rl=readline.createInterface({input:process.stdin});",
      "rl.on('line',line=>{const m=JSON.parse(line);",
      "if(m.method==='initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');",
      "if(m.method==='thread/start') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{thread:{id:'thread-1'}}})+'\\n');",
      "if(m.method==='thread/inject_items') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');",
      "if(m.method==='thread/compact/start'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})+'\\n');setImmediate(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'thread/compacted',params:{threadId:'thread-1',turnId:'turn-1'}})+'\\n'));}",
      "});",
    ].join('');
    const client = CodexAppServerClient.start({
      command: process.execPath,
      args: ['-e', script],
      requestTimeoutMs: 2_000,
    });
    try {
      await expect(client.initialize()).resolves.toEqual({});
      await expect(client.startThread({ model: 'gpt-5.6-sol' })).resolves.toEqual({ thread: { id: 'thread-1' } });
      await expect(client.injectItems('thread-1', [{ type: 'message', role: 'user' }])).resolves.toEqual({});
      const completion = client.waitForCompaction('thread-1');
      await expect(client.compactThread('thread-1')).resolves.toEqual({});
      await expect(completion).resolves.toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
    } finally {
      client.close();
    }
  });
});
