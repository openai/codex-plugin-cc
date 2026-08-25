import fs from "node:fs";

fs.mkdirSync(new URL("../plugins/codex/.generated/app-server-types", import.meta.url), { recursive: true });
