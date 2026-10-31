import { readdirSync, readFileSync } from "fs";

// sync reads: a promise per process costs far more than the tiny /proc reads themselves
export const getProcesses = async () => {
  const out = [];
  for (const pid of readdirSync("/proc")) {
    if (!(+pid > 0)) continue;
    let path;
    try {
      path = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      continue;
    }
    out.push([+pid, path.split("\0")[0], path.split("\0").slice(1)]);
  }
  return out;
};
