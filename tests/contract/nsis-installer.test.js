"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const read = (file) => fs.readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const nsis = read("installer/nsis/Setup.nsi"), bridge = read("installer/NsisBridge.cs"), program = read("installer/Program.cs"), build = read("tools/build-installer.ps1");

test("shipping installer is native Unicode NSIS with no second WinForms UI", () => {
  assert.match(nsis, /Unicode true/);
  assert.match(nsis, /!include "MUI2.nsh"/);
  assert.match(build, /get-nsis.ps1/);
  assert.match(build, /INPUTCHARSET UTF8/);
  assert.match(program, /NsisBridge.Run/);
  assert.doesNotMatch(program, /Application.Run/);
});
test("NSIS defaults to quick AE effect-copy and offers a reversible custom route", () => {
  assert.match(nsis, /StrCpy \$Mode "quick"/);
  assert.match(nsis, /StrCpy \$Ae 1/);
  assert.match(nsis, /StrCpy \$Pr 0/);
  assert.match(nsis, /StrCpy \$Stt 0/);
  assert.match(nsis, /Page custom QuickPage QuickLeave[\s\S]*Page custom CustomPage CustomLeave/);
  assert.match(nsis, /自定义安装…/);
});
test("NSIS enforces PR STT and keeps Vulkan acceleration optional", () => {
  assert.match(nsis, /\$Pr == 1[\s\S]*StrCpy \$Stt 1/);
  assert.match(nsis, /Vulkan GPU\+CPU，无需 CUDA \/ PyTorch/);
  assert.match(bridge, /InstallEffectCopy = ae/);
  assert.match(bridge, /InstallCpuRuntime = quick && stt/);
  assert.match(bridge, /InstallVulkanRuntime = quick && stt && Read\(file, "gpu"\) == "1"/);
});
test("native custom install has folder scan, full scan and path controls without downloads", () => {
  assert.match(nsis, /Function ChooseModelFile/);
  assert.match(nsis, /Function ChooseModelFolder/);
  assert.match(nsis, /Function ChoosePython/);
  assert.match(nsis, /Function ChooseTools/);
  assert.match(nsis, /Function ScanAll[\s\S]*StrCpy \$FullScan 1/);
  assert.match(bridge, /DownloadRecommendedModel = quick && stt/);
  assert.match(bridge, /!options.QuickInstall/);
});
test("NSIS requires download consent and never opens an Adobe host", () => {
  assert.match(nsis, /MUI_LICENSEPAGE_CHECKBOX/);
  assert.match(nsis, /Function LicenseLeave[\s\S]*StrCpy \$Consent 1/);
  assert.match(nsis, /快速安装不扫描本地模型|不会扫描本地模型/);
  assert.doesNotMatch(nsis, /ExecShell.*AfterFX|Exec.*Premiere|MUI_FINISHPAGE_RUN/);
});
test("native uninstaller delegates to the transactional backend and preserves user settings", () => {
  assert.match(nsis, /WriteUninstaller "\$PLUGINSDIR\\Uninstall.exe"/);
  assert.match(nsis, /--uninstall-cli/);
  assert.match(nsis, /已保留用户模型与 setting.txt/);
  assert.match(read("installer/InstallerEngine.cs"), /InstalledBackendPath/);
});
