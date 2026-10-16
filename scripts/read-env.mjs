import { readFileSync } from "node:fs";

// The one reader of web/.env.production for the scripts that check it.
// KEY=VALUE lines only: a form vite reads and this does not, such as an
// inline comment, fails the check rather than passing it.
export function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}
