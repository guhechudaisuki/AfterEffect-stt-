const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.resolve(__dirname, "../../installer/MainForm.cs"), "utf8");
const hostDetectorSource = fs.readFileSync(path.resolve(__dirname, "../../installer/HostDetector.cs"), "utf8");
const engineSource = fs.readFileSync(path.resolve(__dirname, "../../installer/InstallerEngine.cs"), "utf8");
const domainSource = fs.readFileSync(path.resolve(__dirname, "../../installer/Domain.cs"), "utf8");
const manifestSource = fs.readFileSync(path.resolve(__dirname, "../../extension/CSXS/manifest.xml"), "utf8");

test("installer identifies CPU and GPU runtimes as separate visible states", () => {
    assert.match(source, /AddStatusRow\(body, 2, "CPU Whisper/);
    assert.match(source, /AddStatusRow\(body, 3, "GPU Whisper/);
    assert.match(source, /ExistingRuntimePath/);
    assert.match(source, /_installCpu/);
});

test("installer makes AE effect copy mandatory and gates STT on PR", () => {
    assert.match(source, /InstallEffectCopy = _installAfterEffects\.Checked/);
    assert.match(source, /SyncEffectCopyRequirement/);
    assert.match(source, /_installEffectCopy\.Enabled = false/);
    assert.match(source, /bool runtimeReady = quickMode/);
});

test("installer separates quick model download from custom model scanning", () => {
    assert.match(source, /DownloadRecommendedModel/);
    assert.match(source, /ModelDestinationFolder/);
    assert.match(source, /QuickInstall/);
    assert.match(source, /Inspect\(explicitPaths\.ToArray\(\), _quickInstall\.Checked \? null : _modelPath/);
    assert.match(source, /快速安装从零开始；勾选 STT 后只下载推荐模型，不扫描本地模型/);
    assert.match(source, /更改下载目录（可选）/);
    assert.doesNotMatch(source, /已找到校验通过的推荐 Whisper 模型/);
    assert.match(source, /modelDestinationFolder/);
});

test("installer initializes the quick STT control before binding its change event", () => {
    const control = source.indexOf("_quickNeedStt = new CheckBox");
    const binding = source.indexOf("_quickNeedStt.CheckedChanged");
    assert.ok(control >= 0 && binding > control, "quick STT event was bound before the control was constructed");
});

test("installer opens on a quick-install page with a reversible custom-install route", () => {
    assert.match(source, /_quickInstall = new RadioButton[\s\S]*Checked = true/);
    assert.match(source, /_quickPage = BuildQuickInstallPage\(\)/);
    assert.match(source, /_customInstallButton = CreateNavigationButton\("自定义安装…"\)/);
    assert.match(source, /_customInstallButton\.Click[\s\S]*_customInstall\.Checked = true/);
    assert.match(source, /_backToQuickButton = CreateNavigationButton\("← 返回快速安装"\)/);
    assert.match(source, /_backToQuickButton\.Click[\s\S]*_quickInstall\.Checked = true/);
    assert.match(source, /_customPage\.Visible = custom/);
    assert.match(source, /_quickPage\.Visible = !custom/);
});

test("quick installer stacks host and STT copy vertically to avoid overlapping controls", () => {
    assert.match(source, /TableLayoutPanel hostBody = new TableLayoutPanel/);
    assert.match(source, /hostBody\.Controls\.Add\(hostOptions, 0, 0\)/);
    assert.match(source, /hostBody\.Controls\.Add\(hostHint, 0, 1\)/);
    assert.match(source, /TableLayoutPanel sttBody = new TableLayoutPanel/);
    assert.match(source, /sttBody\.Controls\.Add\(sttHint, 0, 0\)/);
    assert.match(source, /sttBody\.Controls\.Add\(_quickModelPanel, 0, 1\)/);
    assert.match(source, /_quickModelFolderLabel = new Label[\s\S]*MaximumSize = new Size\(410, 0\)/);
});

test("quick installer uses a recommended model and exposes optional Vulkan acceleration", () => {
    assert.match(source, /安装字幕识别 STT（默认 CPU）/);
    assert.match(source, /GPU 加速（Vulkan GPU\+CPU，无需 CUDA\/PyTorch）/);
    assert.doesNotMatch(source, /_chooseQuickExistingModel/);
    assert.doesNotMatch(source, /_chooseQuickExistingModelDirectory/);
    assert.match(source, /InstallVulkanRuntime = _quickInstall\.Checked && quickStt && _installVulkan\.Checked/);
    assert.match(engineSource, /快速安装的 STT 默认需要 CPU whisper\.cpp 运行时/);
});

test("quick STT requires CPU readiness and GPU checkbox requires Vulkan readiness", () => {
    assert.match(source, /bool quickCpuReady = quickMode && SyncQuickRuntimeSelection\(sttRequested\)/);
    assert.match(source, /bool quickGpuRequested = _quickInstall\.Checked/);
    assert.match(source, /bool quickGpuReady = !quickGpuRequested/);
    assert.match(source, /bool runtimeReady = quickMode \? quickCpuReady && quickGpuReady : customRuntimeReady/);
});

test("custom install is bring-your-own-resource and cannot download runtimes", () => {
    assert.match(source, /自定义安装仅接入你已有的 Whisper 模型和运行环境/);
    assert.match(source, /_installCpu\.Visible = false/);
    assert.match(source, /_installVulkan\.Visible = false/);
    assert.match(source, /_acceptLicense\.Visible = false/);
    assert.match(source, /bool customRuntimeReady = !sttRequested \|\| existingRuntimeReady/);
    assert.match(source, /: !selectedPr \|\| IsSelectedModelReady\(\)/);
    assert.match(engineSource, /!options\.QuickInstall && \(options\.InstallCpuRuntime \|\| options\.InstallVulkanRuntime \|\| options\.DownloadRecommendedModel\)/);
    assert.match(engineSource, /自定义安装使用 PR\/STT 时必须指定本地 Whisper 模型/);
    assert.match(engineSource, /自定义安装指定的 Whisper 模型无效或未被识别/);
});

test("installer and extension accept Adobe 2020 and newer hosts", () => {
    assert.match(domainSource, /MinimumSupportedHostMajor = 17/);
    assert.match(source, /ProductInfo\.IsSupportedHostVersion\(major, minor\)/);
    assert.match(hostDetectorSource, /ProductInfo\.IsSupportedHostVersion\(major, minor\)/);
    assert.match(engineSource, /受支持的 2020\+ 版本/);
    assert.match(manifestSource, /Version="\[17\.0,999\.0\)"/g);
});

test("host detection probes both Windows program roots and nested Adobe executables", () => {
    assert.match(hostDetectorSource, /Environment\.SpecialFolder\.ProgramFilesX86/);
    assert.match(hostDetectorSource, /ProgramW6432/);
    assert.match(hostDetectorSource, /Directory\.GetFiles\(adobeRoot, spec\.ExecutableNames\[e\], SearchOption\.AllDirectories\)/);
    assert.match(hostDetectorSource, /AddAdobeRootsOnFixedDrives/);
    assert.match(hostDetectorSource, /AddAdjacentAdobeRoots/);
});

test("quick install always downloads the recommended model from a clean start", () => {
    assert.match(source, /bool downloadRecommendedModel = quickStt/);
    assert.match(source, /DownloadRecommendedModel = downloadRecommendedModel/);
    assert.match(engineSource, /bool sttRequested = options\.InstallPremiere \|\| options\.DownloadRecommendedModel/);
    assert.match(source, /ModelPath = _quickInstall\.Checked \? null : _modelPath/);
});
