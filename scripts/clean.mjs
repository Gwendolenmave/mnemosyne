import { rmSync } from "node:fs";

rmSync(new URL("../build", import.meta.url), { recursive: true, force: true });
