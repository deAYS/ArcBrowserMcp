import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = new URL("..", import.meta.url);

/**
 * Build the server before integration tests run so the stdio fixture always
 * exercises the current compiled output (dist/index.js), exactly as a real
 * MCP client would launch it.
 *
 * Runs the project-local tsc through the current Node binary (no shell, no
 * PATH lookup) so this works on Windows without .cmd shim resolution.
 */
export default async function globalSetup(): Promise<void> {
  const tsc = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, [tsc, "-p", "tsconfig.build.json"], { cwd: REPO_ROOT }, (error) => {
      if (error instanceof Error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
