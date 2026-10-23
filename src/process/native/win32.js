import { dlopen, getRawPointer } from 'node:ffi';

const k32 = dlopen('kernel32.dll', {
  CreateToolhelp32Snapshot: { arguments: ['u32', 'u32'], return: 'pointer' },
  Process32FirstW: { arguments: ['pointer', 'buffer'], return: 'i32' },
  Process32NextW: { arguments: ['pointer', 'buffer'], return: 'i32' },
  OpenProcess: { arguments: ['u32', 'i32', 'u32'], return: 'pointer' },
  QueryFullProcessImageNameW: { arguments: ['pointer', 'u32', 'buffer', 'buffer'], return: 'i32' },
  CloseHandle: { arguments: ['pointer'], return: 'i32' },
}).functions;

const ntdll = dlopen('ntdll.dll', {
  NtQueryInformationProcess: {
    arguments: ['pointer', 'u32', 'buffer', 'u32', 'buffer'],
    return: 'i32',
  },
}).functions;

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const ProcessCommandLineInformation = 60;

// PROCESSENTRY32W on 64-bit: 568 bytes. PID at +8, szExeFile at +44.
const ENTRY_SIZE = 568;

function getImagePath(h) {
  const buf = Buffer.alloc(32768 * 2);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(32768);
  if (!k32.QueryFullProcessImageNameW(h, 0, buf, len)) return null;
  return buf.toString('utf16le', 0, len.readUInt32LE(0) * 2);
}

function getCommandLine(h) {
  let size = 1024;
  for (let attempt = 0; attempt < 3; attempt++) {
    const buf = Buffer.alloc(size);
    const retLen = Buffer.alloc(4);
    const status = ntdll.NtQueryInformationProcess(
      h, ProcessCommandLineInformation, buf, size, retLen,
    );
    if (status >= 0) {
      // buf starts with a UNICODE_STRING: u16 Length, u16 MaxLength, (pad), PWSTR Buffer.
      // The pointer targets the string data stored later in this same buffer.
      const length = buf.readUInt16LE(0);
      const ptr = buf.readBigUInt64LE(8);
      const offset = Number(ptr - BigInt(getRawPointer(buf)));
      return buf.toString('utf16le', offset, offset + length);
    }
    const needed = retLen.readUInt32LE(0);
    if (needed <= size) return null; // some other failure, e.g. access denied
    size = needed;
  }
  return null;
}

const MAX_TRIES = 3; // retry failed lookups a few times, since a just-spawned or exiting process can fail transiently
const cache = new Map();

function lookup(pid) {
  const h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  if (!h) return null;
  try {
    const path = getImagePath(h);
    if (!path) return null;
    const cmd = getCommandLine(h);
    return { path, args: cmd ? splitCommandLine(cmd) : null };
  } finally {
    k32.CloseHandle(h);
  }
}

export function getProcesses() {
  const snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snap === INVALID_HANDLE_VALUE) throw new Error('CreateToolhelp32Snapshot failed');

  const processes = [];
  const seen = new Set();

  try {
    const entry = Buffer.alloc(ENTRY_SIZE);
    entry.writeUInt32LE(ENTRY_SIZE, 0);

    let ok = k32.Process32FirstW(snap, entry);
    while (ok) {
      const pid = entry.readUInt32LE(8);
      const ppid = entry.readUInt32LE(32);
      const exe = entry.toString('utf16le', 44, 44 + 520).split('\0', 1)[0];
      const key = `${pid}:${ppid}:${exe}`;
      seen.add(key);

      let cached = cache.get(key);
      if (!cached || (cached.info === null && cached.tries < MAX_TRIES)) {
        const info = lookup(pid);
        cached = { info, tries: (cached?.tries ?? 0) + 1 };
        cache.set(key, cached);
      }
      if (cached.info) processes.push([pid, cached.info.path, cached.info.args]);

      ok = k32.Process32NextW(snap, entry);
    }
  } finally {
    k32.CloseHandle(snap);
  }

  // Evict entries for processes that no longer exist
  for (const key of cache.keys()) if (!seen.has(key)) cache.delete(key);

  return processes;
}

function splitCommandLine(cmd) {
  const args = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) {
    args.push(m[1] !== undefined ? m[1] : m[2]);
  }
  return args;
}
