import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
const files = (await readdir("release")).filter(f => /\.(exe|dmg|deb|gz)$/.test(f)).sort();
if (!files.length) throw new Error("No delivery artifacts generated");
const sums = await Promise.all(files.map(async f => `${createHash("sha256").update(await readFile(`release/${f}`)).digest("hex")}  ${f}`));
await writeFile("release/SHA256SUMS.txt", sums.join("\n") + "\n");
