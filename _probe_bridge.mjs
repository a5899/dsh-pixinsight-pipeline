// probe_bridge.mjs — instrument the real send() path to see what it actually does.
import { pathToFileURL } from 'node:url';
const { createBridgeContext } = await import(
  pathToFileURL('C:/Users/a5093/.dsh/pixinsight-mcp/agents/ops/bridge.mjs').href
);
import fs from 'node:fs';
import path from 'node:path';

const CMD = 'C:/Users/a5093/.pixinsight-mcp/bridge/commands';
const RES = 'C:/Users/a5093/.pixinsight-mcp/bridge/results';

const list = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

console.log('before -> commands:', list(CMD).length, 'results:', list(RES).length);

const ctx = createBridgeContext({});
const t0 = Date.now();
const r = await ctx.pjsr('1+1');
console.log('pjsr result status:', r.status, 'took', Date.now() - t0, 'ms');
console.log('after  -> commands:', list(CMD).length, 'results:', list(RES).length);
console.log('commands now:', list(CMD).slice(-5).join(', '));
console.log('results now:', list(RES).slice(-5).join(', '));

// Same check but through a second, brand-new context, to rule out state.
const ctx2 = createBridgeContext({});
const r2 = await ctx2.pjsr('2+2');
console.log('\nsecond context status:', r2.status);
console.log('after2 -> commands:', list(CMD).length, 'results:', list(RES).length);
console.log('commands now:', list(CMD).slice(-5).join(', '));
