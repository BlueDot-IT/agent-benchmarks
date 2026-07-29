import { readFile, writeFile } from "node:fs/promises";

const countPath = new URL("./attempt-count.txt", import.meta.url);
const recoveryPath = new URL("./recovery.json", import.meta.url);

let attempts = 0;
try {
  attempts = Number.parseInt(await readFile(countPath, "utf8"), 10);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

attempts += 1;
await writeFile(countPath, `${attempts}\n`);

if (attempts === 1) {
  console.error("transient dependency unavailable; retry the same command");
  process.exitCode = 75;
} else if (attempts === 2) {
  await writeFile(recoveryPath, `${JSON.stringify({ status: "recovered", attempts })}\n`);
  console.log("dependency recovered");
} else {
  console.error("unexpected extra attempt after recovery");
  process.exitCode = 1;
}
