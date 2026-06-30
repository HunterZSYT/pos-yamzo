import fs from "node:fs";
import path from "node:path";

const releaseDir = path.resolve("release");
const fallbackReleaseDir = path.resolve("release-packaged");
const cwd = process.cwd();

for (const dir of [releaseDir, fallbackReleaseDir]) {
  if (!dir.startsWith(cwd)) {
    throw new Error(`Refusing to clean outside project: ${dir}`);
  }
}

fs.rmSync(releaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
fs.rmSync(fallbackReleaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
fs.mkdirSync(releaseDir, { recursive: true });
