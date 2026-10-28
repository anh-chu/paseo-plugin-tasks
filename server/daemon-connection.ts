import { access, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHandlerContext["paseo"];

// Use the installed CLI's own connection setup so the bridge connects to the
// same local daemon and uses its existing credentials, including custom homes.
export async function connectBridgeDaemon(): Promise<{ paseo: PaseoApi; close(): Promise<void> }> {
  let executable: string | undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? "paseo.cmd" : "paseo");
    try {
      await access(candidate, constants.X_OK);
      executable = await realpath(candidate);
      break;
    } catch { /* Try the next PATH entry. */ }
  }
  if (!executable) throw new Error("Cannot connect Tasks to Paseo: the paseo CLI is not on PATH.");
  const packageRoot = dirname(dirname(executable));
  const cliModule = pathToFileURL(join(packageRoot, "dist", "utils", "client.js")).href;
  const cli = await import(cliModule) as { connectToDaemon(options: unknown): Promise<{ close(): Promise<void> }> };
  const requireFromCli = createRequire(join(packageRoot, "package.json"));
  const sdk = await import(pathToFileURL(requireFromCli.resolve("@getpaseo/client")).href) as { createPaseoApi(client: unknown): PaseoApi };
  const home = process.env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  const client = await cli.connectToDaemon({ target: { kind: "instance", home }, timeout: 5000 });
  try {
    return { paseo: sdk.createPaseoApi(client), close: () => client.close() };
  } catch (error) {
    await client.close();
    throw error;
  }
}
