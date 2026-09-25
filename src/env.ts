/** Loads ./.env (gitignored) into process.env if present. Real env vars win over the file. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./world/dataset.js";

const file = join(REPO_ROOT, ".env");
if (existsSync(file)) process.loadEnvFile(file);
