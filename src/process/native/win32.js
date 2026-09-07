import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function getProcesses() {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'
  ]);

  const rows = JSON.parse(stdout);
  const list = Array.isArray(rows) ? rows : [rows]; // single result isn't wrapped in an array

  return list.map(r => [
    r.ProcessId,
    r.ExecutablePath ?? null,
    r.CommandLine ? splitCommandLine(r.CommandLine) : null,
  ]);
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