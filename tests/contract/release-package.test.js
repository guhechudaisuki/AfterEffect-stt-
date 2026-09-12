const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workspace = path.resolve(__dirname, "../..");
const read = (relativePath) => fs.readFileSync(path.join(workspace, relativePath), "utf8");

function matchOne(source, expression, label) {
  const match = expression.exec(source);
  assert.ok(match, `missing ${label}`);
  return match[1];
}

test("all release version surfaces match package.json", () => {
  const version = JSON.parse(read("package.json")).version;
  const dotted = version + ".0";
  const manifest = read("extension/CSXS/manifest.xml");
  assert.equal(matchOne(manifest, /ExtensionBundleVersion="([^"]+)"/, "CEP bundle version"), version);
  assert.equal(matchOne(manifest, /<Extension Id="com\.localwhisper\.subtitles\.panel" Version="([^"]+)"/, "CEP extension version"), version);
  assert.equal(matchOne(read("installer/Domain.cs"), /public const string Version = "([^"]+)"/, "installer product version"), version);
  assert.equal(matchOne(read("installer/Properties/AssemblyInfo.cs"), /AssemblyVersion\("([^"]+)"\)/, "assembly version"), dotted);
  assert.equal(matchOne(read("installer/app.manifest"), /assemblyIdentity version="([^"]+)"/, "Win32 manifest version"), dotted);
  assert.equal(JSON.parse(read("resources/manifest.json")).productVersion, version);
  assert.match(read("tools/publish-dist.ps1"), new RegExp(`LocalWhisperSubtitles-${version.replaceAll(".", "\\.")}-win-x64`));
  assert.match(read("installer/InstallerEngine.cs"), /LocalWhisperSubtitles-ModelDownload\/" \+ ProductInfo\.Version/);
});

test("installer payload staging excludes local Python bytecode and caches", () => {
  const build = read("tools/build-installer.ps1");
  assert.match(build, /payloadStaging/i);
  assert.match(build, /__pycache__/i);
  assert.match(build, /\.pyc/i);
  assert.doesNotMatch(build, /CreateFromDirectory\(\s*\$extensionRoot,/);
});

test("resource integrity verification does not depend on PowerShell module auto-loading", { skip: process.platform !== "win32" }, () => {
  const script = path.join(workspace, "tools/generate-resource-manifest.ps1");
  const resources = path.join(workspace, "resources");
  const result = childProcess.spawnSync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", script,
    "-ResourcesRoot", resources,
    "-Check"
  ], {
    cwd: workspace,
    env: process.env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));
  assert.match(result.stdout, /Resource manifest verified:/);
});
