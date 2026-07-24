import { setAppPathOverride } from '../../src/config.js';

const workerId = process.env['CONFIG_WRITE_WORKER_ID'];
const writes = Number(process.env['CONFIG_WRITE_COUNT']);
if (!workerId || !Number.isInteger(writes) || writes <= 0) {
  throw new Error('Config write worker requires an id and positive write count.');
}

process.stdin.resume();
process.stdin.once('data', () => {
  for (let index = 0; index < writes; index += 1) {
    const key = `${workerId}-${index}`;
    setAppPathOverride(key, `/tmp/${key}`);
  }
});
process.stdout.write('READY\n');
