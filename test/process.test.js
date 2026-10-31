import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

let processes = [];
const getProcesses = async () => processes;
mock.module('../src/process/native/index.js', {
  namedExports: { linux: { getProcesses }, win32: { getProcesses }, darwin: { getProcesses } }
});
console.log = () => {};
const { default: ProcessServer } = await import('../src/process/index.js');

// matching loop from before the index, used as the reference
const reference = (db, procs) => {
  const out = [];
  for (const [pid, path, args] of procs) {
    const splitPath = path.toLowerCase().replaceAll('\\', '/').split('/');
    if ((splitPath[0].length == 2 && splitPath[0].endsWith(':') || splitPath[0] == "")) splitPath.shift();
    const toCompare = [];
    for (let i = 0; i < splitPath.length; i++) toCompare.push(splitPath.slice(-i).join('/'));
    for (const p of toCompare.slice()) {
      toCompare.push(p.replace('64', ''));
      toCompare.push(p.replace('.x64', ''));
      toCompare.push(p.replace('x64', ''));
      toCompare.push(p.replace('_64', ''));
    }
    for (const { executables, id } of db) {
      if (executables?.some(x => {
        if (x.is_launcher) return false;
        if (x.name[0] === '>' ? x.name.substring(1) !== toCompare[0] : !toCompare.some(y => x.name === y)) return false;
        if (args && x.arguments) return args.join(" ").indexOf(x.arguments) > -1;
        return true;
      })) out.push([id, pid]);
    }
  }
  return out;
};

const scan = async (server, procs) => {
  processes = procs;
  const sent = [];
  server.handlers = { message: (_, msg) => msg.args.activity && sent.push([msg.args.activity.application_id, msg.args.pid]) };
  await server.scan();
  return sent;
};

const newServer = db => Object.assign(Object.create(ProcessServer.prototype), { DetectableDB: db });

const random = seed => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
const PARTS = ['game', 'Game', 'bin', 'x64', 'win64', '_64', '64', '.x64', 'app.exe', 'Play.EXE', 'ünï', 'a b'];

test('detects exactly what the reference loop detects, in the same order', async () => {
  let detected = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const r = random(seed);
    const pick = () => PARTS[Math.floor(r() * PARTS.length)];
    const name = () => {
      const s = Array.from({ length: 1 + Math.floor(r() * 3) }, pick).join(r() < 0.5 ? '' : '/');
      return (r() < 0.1 ? '>' : '') + (r() < 0.3 ? s.toLowerCase() : s);
    };
    const db = Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      name: `Game ${i}`,
      executables: r() < 0.1 ? undefined : Array.from({ length: Math.floor(r() * 4) }, () => ({
        name: name(), is_launcher: r() < 0.15, ...(r() < 0.2 ? { arguments: pick() } : {})
      }))
    }));
    const known = db.flatMap(e => (e.executables ?? []).map(x => x.name.replace(/^>/, '')));
    const procs = Array.from({ length: 20 }, (_, pid) => {
      const prefix = ['/', '/opt/', 'C:\\Games\\', '', 'relative/'][Math.floor(r() * 5)];
      let path = prefix + (r() < 0.7 && known.length ? known[Math.floor(r() * known.length)] : name());
      if (r() < 0.3) path = path.toUpperCase();
      return [pid + 1, path, r() < 0.5 ? [pick(), '--flag'] : []];
    });

    const expected = reference(db, procs);
    assert.deepEqual(await scan(newServer(db), procs), expected, `seed ${seed}`);
    detected += expected.length;
  }
  assert.ok(detected > 500);
});

test('rebuilds the index when the database is replaced', async () => {
  const server = newServer([{ id: '1', name: 'Old', executables: [{ name: 'old.exe' }] }]);
  const procs = [[1, '/games/old.exe', []], [2, '/games/new.exe', []]];
  assert.deepEqual(await scan(server, procs), [['1', 1]]);
  server.DetectableDB = [...server.DetectableDB, { id: '2', name: 'New', executables: [{ name: 'new.exe' }] }];
  assert.deepEqual(await scan(server, procs), [['1', 1], ['2', 2]]);
});

test('linux getProcesses lists this process', { skip: process.platform !== 'linux' }, async () => {
  const { getProcesses: real } = await import('../src/process/native/linux.js');
  const own = (await real()).find(([pid]) => pid === process.pid);
  assert.ok(own, 'own pid present');
  assert.equal(own[1], process.argv0);
  assert.ok(own[2].some(arg => arg.endsWith('process.test.js')), 'arguments present');
});
