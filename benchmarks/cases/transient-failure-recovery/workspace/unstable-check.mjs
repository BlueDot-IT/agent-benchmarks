import { readFile } from "node:fs/promises";

const countPath = new URL("./attempt-count.txt", import.meta.url);

let attempts = 0;
try {
  attempts = Number.parseInt(await readFile(countPath, "utf8"), 10);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

if (attempts < 1) {
  console.error("transient dependency unavailable; retry the same command");
  process.exitCode = 75;
} else {
  console.log("dependency recovered");
}
