import { CLI_VERSION } from "../version";

export async function printVersion() {
  console.log(`atelier v${CLI_VERSION}`);
}
