import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "plugins", "codex", "scripts", "run-node.sh");
const BASH = process.env.SHELL || (process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash");
const VERSION_MANAGER_ENV_KEYS = new Set([
  "nvm_dir",
  "nvm_symlink",
  "fnm_dir",
  "asdf_data_dir",
  "mise_data_dir",
  "homebrew_prefix",
  "volta_home",
  "localappdata",
  "programfiles",
  "programw6432"
]);

function cleanVersionManagerEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !VERSION_MANAGER_ENV_KEYS.has(key.toLowerCase()))
  );
}


function installFakeNode(home, version, supported) {
  const binDir = path.join(home, ".nvm", "versions", "node", version, "bin");
  const nodePath = path.join(binDir, "node");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(nodePath, `#!/bin/sh\nif [ "\${1:-}" = "-e" ]; then exit ${supported ? 0 : 1}; fi\nprintf 'FAKE_NODE_${version}:%s\\n' "$*"\nprintf 'CODEX:%s\\n' "$(command -v codex || true)"\n`, "utf8");
  fs.chmodSync(nodePath, 0o755);
  return binDir;
}

function runWithMinimalPath(home) {
  const emptyBin = path.join(home, "empty-bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  return spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
    encoding: "utf8",
    env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: emptyBin.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
  });
}

test("portable launcher preserves the selected Node toolchain directory on PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-path-"));
  const binDir = installFakeNode(home, "v22.0.0", true);
  const codexPath = path.join(binDir, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  try {
    const result = runWithMinimalPath(home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CODEX:.+[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher skips unsupported Node versions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-version-"));
  installFakeNode(home, "v12.22.0", false);
  installFakeNode(home, "v22.0.0", true);
  try {
    const result = runWithMinimalPath(home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FAKE_NODE_v22\.0\.0:/);
    assert.doesNotMatch(result.stdout, /FAKE_NODE_v12\.22\.0:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher keeps searching compatible toolchains for codex", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-mixed-path-"));
  const systemBin = path.join(home, "system-bin");
  fs.mkdirSync(systemBin, { recursive: true });
  const systemNode = path.join(systemBin, "node");
  fs.writeFileSync(systemNode, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf \'SYSTEM_NODE:%s\\n\' "$*"\nprintf \'CODEX:%s\\n\' "$(command -v codex || true)"\n', "utf8");
  fs.chmodSync(systemNode, 0o755);

  const managedBin = installFakeNode(home, "v22.0.0", true);
  const codexPath = path.join(managedBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);

  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: systemBin.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FAKE_NODE_v22\.0\.0:/);
    assert.doesNotMatch(result.stdout, /SYSTEM_NODE:/);
    assert.match(result.stdout, /CODEX:.+[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Regression for review: minimal Git Bash PATH must still discover a normal Windows Node install.
test("portable launcher discovers Windows Node install roots under Git Bash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-windows-"));
  const emptyBin = path.join(home, "empty-bin");
  const programFiles = path.join(home, "Program Files");
  const programFilesPosix = programFiles
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
    .replaceAll("\\", "/");
  const nodeDir = path.join(programFiles, "nodejs");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(nodeDir, { recursive: true });
  const cygpath = path.join(emptyBin, "cygpath");
  fs.writeFileSync(cygpath, '#!/bin/sh\nif [ "${1:-}" = "-u" ]; then shift; fi\nprintf "%s\\n" "$1"\n', "utf8");
  fs.chmodSync(cygpath, 0o755);
  const nodePath = path.join(nodeDir, "node.exe");
  fs.copyFileSync(process.execPath, nodePath);
  const probeName = `windows-node-probe-${process.pid}.mjs`;
  const probePath = path.join(path.dirname(LAUNCHER), probeName);
  fs.writeFileSync(probePath, 'console.log("WINDOWS_NODE")\n', "utf8");
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), probeName], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: emptyBin.replaceAll("\\", "/"), PROGRAMFILES: programFilesPosix, CODEX_COMPANION_NODE: "", NVM_SYMLINK: "", VOLTA_HOME: "", LOCALAPPDATA: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /WINDOWS_NODE/);
  } finally {
    fs.rmSync(probePath, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("portable launcher restores a configured npm global prefix for codex", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-npm-prefix-"));
  const nodeBin = installFakeNode(home, "v22.0.0", true);
  const prefix = path.join(home, ".npm-global");
  const prefixBin = path.join(prefix, "bin");
  fs.mkdirSync(prefixBin, { recursive: true });
  const codexPath = path.join(prefixBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: {
        ...cleanVersionManagerEnv(),
        HOME: home.replaceAll("\\", "/"),
        PATH: nodeBin.replaceAll("\\", "/"),
        NPM_CONFIG_PREFIX: prefix.replaceAll("\\", "/"),
        CODEX_COMPANION_NODE: ""
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CODEX:.+[\\/]\.npm-global[\\/]bin[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("portable launcher restores npm prefix reported by npm config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-npm-config-"));
  const nodeBin = installFakeNode(home, "v22.0.0", true);
  const prefix = path.join(home, ".npm-configured");
  const prefixBin = path.join(prefix, "bin");
  fs.mkdirSync(prefixBin, { recursive: true });
  const codexPath = path.join(prefixBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  const npmPath = path.join(nodeBin, "npm");
  fs.writeFileSync(
    npmPath,
    `#!/bin/sh\nif [ "\${1:-}" = "prefix" ] && [ "\${2:-}" = "-g" ]; then printf '%s\\n' "${prefix.replaceAll("\\", "/")}"; exit 0; fi\nexit 1\n`,
    "utf8"
  );
  fs.chmodSync(npmPath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: {
        ...cleanVersionManagerEnv(),
        HOME: home.replaceAll("\\", "/"),
        PATH: nodeBin.replaceAll("\\", "/"),
        NPM_CONFIG_PREFIX: "",
        CODEX_COMPANION_NODE: ""
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CODEX:.+[\\/]\.npm-configured[\\/]bin[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("portable launcher discovers Node from a custom NVM_DIR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-custom-nvm-"));
  const emptyBin = path.join(home, "empty-bin");
  const nvmDir = path.join(home, "custom-nvm");
  const binDir = path.join(nvmDir, "versions", "node", "v22.0.0", "bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, "node");
  fs.writeFileSync(nodePath, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "CUSTOM_NVM_NODE:%s\\n" "$*"\n', "utf8");
  fs.chmodSync(nodePath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: emptyBin.replaceAll("\\", "/"), NVM_DIR: nvmDir.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "", NVM_SYMLINK: "", VOLTA_HOME: "", LOCALAPPDATA: "", ProgramFiles: "", PROGRAMFILES: "", PROGRAMW6432: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOM_NVM_NODE:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher enriches PATH from a custom NVM_DIR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-custom-nvm-path-"));
  const systemBin = path.join(home, "system-bin");
  const nvmDir = path.join(home, "custom-nvm");
  const managedBin = path.join(nvmDir, "versions", "node", "v22.0.0", "bin");
  fs.mkdirSync(systemBin, { recursive: true });
  fs.mkdirSync(managedBin, { recursive: true });
  const systemNode = path.join(systemBin, "node");
  fs.writeFileSync(systemNode, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "SYSTEM_NODE:%s\\n" "$*"\nprintf "CODEX:%s\\n" "$(command -v codex || true)"\n', "utf8");
  fs.chmodSync(systemNode, 0o755);
  const managedNode = path.join(managedBin, "node");
  fs.writeFileSync(managedNode, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "CUSTOM_NVM_MANAGED:%s\\n" "$*"\nprintf "CODEX:%s\\n" "$(command -v codex || true)"\n', "utf8");
  fs.chmodSync(managedNode, 0o755);
  const codexPath = path.join(managedBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: systemBin.replaceAll("\\", "/"), NVM_DIR: nvmDir.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOM_NVM_MANAGED:/);
    assert.doesNotMatch(result.stdout, /SYSTEM_NODE:/);
    assert.match(result.stdout, /CODEX:.+[\\/]custom-nvm[\\/]versions[\\/]node[\\/]v22\.0\.0[\\/]bin[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("portable launcher discovers Node from a custom FNM_DIR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-custom-fnm-"));
  const emptyBin = path.join(home, "empty-bin");
  const fnmDir = path.join(home, "custom-fnm");
  const binDir = path.join(fnmDir, "node-versions", "v22.0.0", "installation", "bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, "node");
  fs.writeFileSync(nodePath, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "CUSTOM_FNM_NODE:%s\\n" "$*"\n', "utf8");
  fs.chmodSync(nodePath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: emptyBin.replaceAll("\\", "/"), FNM_DIR: fnmDir.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOM_FNM_NODE:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher aligns Node and codex from a custom FNM_DIR", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-custom-fnm-path-"));
  const systemBin = path.join(home, "system-bin");
  const fnmDir = path.join(home, "custom-fnm");
  const managedBin = path.join(fnmDir, "node-versions", "v24.2.0", "installation", "bin");
  fs.mkdirSync(systemBin, { recursive: true });
  fs.mkdirSync(managedBin, { recursive: true });
  const systemNode = path.join(systemBin, "node");
  fs.writeFileSync(systemNode, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "SYSTEM_NODE:%s\\n" "$*"\n', "utf8");
  fs.chmodSync(systemNode, 0o755);
  const managedNode = path.join(managedBin, "node");
  fs.writeFileSync(managedNode, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "CUSTOM_FNM_MANAGED:%s\\n" "$*"\nprintf "CODEX:%s\\n" "$(command -v codex || true)"\n', "utf8");
  fs.chmodSync(managedNode, 0o755);
  const codexPath = path.join(managedBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: systemBin.replaceAll("\\", "/"), FNM_DIR: fnmDir.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CUSTOM_FNM_MANAGED:/);
    assert.doesNotMatch(result.stdout, /SYSTEM_NODE:/);
    assert.match(result.stdout, /CODEX:.+[\\/]custom-fnm[\\/]node-versions[\\/]v24\.2\.0[\\/]installation[\\/]bin[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


test("portable launcher honors custom ASDF_DATA_DIR and MISE_DATA_DIR", () => {
  const cases = [
    { envKey: "ASDF_DATA_DIR", label: "ASDF", relative: ["installs", "nodejs", "v22.0.0", "bin"] },
    { envKey: "MISE_DATA_DIR", label: "MISE", relative: ["installs", "node", "v22.0.0", "bin"] }
  ];
  for (const { envKey, label, relative } of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `codex-node-custom-${label.toLowerCase()}-`));
    const emptyBin = path.join(home, "empty-bin");
    const dataDir = path.join(home, `custom-${label.toLowerCase()}`);
    const binDir = path.join(dataDir, ...relative);
    fs.mkdirSync(emptyBin, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    const nodePath = path.join(binDir, "node");
    fs.writeFileSync(nodePath, `#!/bin/sh\nif [ "\${1:-}" = "-e" ]; then exit 0; fi\nprintf '${label}_NODE:%s\\n' "$*"\n`, "utf8");
    fs.chmodSync(nodePath, 0o755);
    try {
      const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\\\", "/"), "companion.mjs", "status", "--json"], {
        encoding: "utf8",
        env: {
          ...cleanVersionManagerEnv(),
          HOME: home.replaceAll("\\\\", "/"),
          PATH: emptyBin.replaceAll("\\\\", "/"),
          ASDF_DATA_DIR: "",
          MISE_DATA_DIR: "",
          [envKey]: dataDir.replaceAll("\\\\", "/"),
          CODEX_COMPANION_NODE: ""
        }
      });
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${label}_NODE:`));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test("portable launcher honors HOMEBREW_PREFIX under a minimal PATH", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-homebrew-prefix-"));
  const emptyBin = path.join(home, "empty-bin");
  const brewPrefix = path.join(home, "linuxbrew-prefix");
  const binDir = path.join(brewPrefix, "bin");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const nodePath = path.join(binDir, "node");
  fs.writeFileSync(nodePath, '#!/bin/sh\nif [ "${1:-}" = "-e" ]; then exit 0; fi\nprintf "HOMEBREW_NODE:%s\\n" "$*"\n', "utf8");
  fs.chmodSync(nodePath, 0o755);
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), "companion.mjs", "status", "--json"], {
      encoding: "utf8",
      env: { ...cleanVersionManagerEnv(), HOME: home.replaceAll("\\", "/"), PATH: emptyBin.replaceAll("\\", "/"), HOMEBREW_PREFIX: brewPrefix.replaceAll("\\", "/"), CODEX_COMPANION_NODE: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /HOMEBREW_NODE:/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher accepts CODEX_COMPANION_NODE as a native Windows path", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-configured-windows-"));
  const emptyBin = path.join(home, "empty-bin");
  const portableDir = path.join(home, "Portable Node");
  fs.mkdirSync(emptyBin, { recursive: true });
  fs.mkdirSync(portableDir, { recursive: true });
  const nodePath = path.join(portableDir, "node.exe");
  fs.copyFileSync(process.execPath, nodePath);
  const probeName = `configured-node-probe-${process.pid}.mjs`;
  const probePath = path.join(path.dirname(LAUNCHER), probeName);
  fs.writeFileSync(probePath, 'console.log("CONFIGURED_WINDOWS_NODE"); console.log("PATH:" + (process.env.PATH ?? ""));\n', "utf8");
  try {
    const result = spawnSync(BASH, [LAUNCHER.replaceAll("\\", "/"), probeName], {
      encoding: "utf8",
      env: {
        ...cleanVersionManagerEnv(),
        HOME: home.replaceAll("\\", "/"),
        PATH: emptyBin.replaceAll("\\", "/"),
        CODEX_COMPANION_NODE: nodePath,
        NVM_DIR: "",
        NVM_SYMLINK: "",
        VOLTA_HOME: "",
        LOCALAPPDATA: "",
        ProgramFiles: "",
        PROGRAMFILES: "",
        PROGRAMW6432: ""
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /CONFIGURED_WINDOWS_NODE/);
    assert.match(result.stdout, /PATH:.*Portable Node/i);
  } finally {
    fs.rmSync(probePath, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("portable launcher aligns Node with the supported toolchain that contains codex", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-node-multi-supported-"));
  installFakeNode(home, "v20.19.0", true);
  const newerBin = installFakeNode(home, "v24.2.0", true);
  const codexPath = path.join(newerBin, "codex");
  fs.writeFileSync(codexPath, "#!/bin/sh\nexit 0\n", "utf8");
  fs.chmodSync(codexPath, 0o755);
  try {
    const result = runWithMinimalPath(home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /FAKE_NODE_v24\.2\.0:/);
    assert.doesNotMatch(result.stdout, /FAKE_NODE_v20\.19\.0:/);
    assert.match(result.stdout, /CODEX:.+[\\/]v24\.2\.0[\\/]bin[\\/]codex\n$/m);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
