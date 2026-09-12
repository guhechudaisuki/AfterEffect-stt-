using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace LocalWhisperSubtitles.Setup
{
    internal sealed class InstallerEngine
    {
        private const string ExtensionResourceName = "ExtensionPayload.zip";
        private const string CsxsRegistryPath = @"Software\Adobe\CSXS.11";
        private const string UninstallRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LocalWhisperSubtitles";

        private readonly string _executablePath;
        private readonly string _resourcesRoot;
        private readonly AppPaths _paths;

        public AppPaths Paths { get { return _paths; } }
        public string ResourcesRoot { get { return _resourcesRoot; } }

        public InstallerEngine(string executablePath)
            : this(executablePath, Path.Combine(Path.GetDirectoryName(Path.GetFullPath(executablePath)), "resources"), AppPaths.ForCurrentUser())
        {
        }

        internal InstallerEngine(string executablePath, string resourcesRoot, AppPaths paths)
        {
            _executablePath = Path.GetFullPath(executablePath);
            _resourcesRoot = Path.GetFullPath(resourcesRoot);
            _paths = paths;
        }

        public InspectionResult Inspect()
        {
            return Inspect(null);
        }

        public InspectionResult Inspect(string[] explicitHostExecutablePaths)
        {
            return Inspect(explicitHostExecutablePaths, null);
        }

        public InspectionResult Inspect(string[] explicitHostExecutablePaths, string explicitModelPath)
        {
            return Inspect(explicitHostExecutablePaths, explicitModelPath, null);
        }

        public InspectionResult Inspect(string[] explicitHostExecutablePaths, string explicitModelPath, string explicitPythonPath)
        {
            return Inspect(explicitHostExecutablePaths, explicitModelPath, explicitPythonPath, true);
        }

        public InspectionResult Inspect(string[] explicitHostExecutablePaths, string explicitModelPath, string explicitPythonPath, bool scanModels)
        {
            List<string> modelRoots = new List<string>(ModelDetector.DefaultRoots());
            modelRoots.Add(Path.Combine(_resourcesRoot, "models"));
            InspectionResult result = new InspectionResult
            {
                Hosts = HostDetector.DetectSupportedHosts(explicitHostExecutablePaths),
                ExistingRuntimePath = InstalledRuntimeDetector.Find(_paths),
                ExistingVulkanRuntimePath = InstalledRuntimeDetector.FindVulkan(_paths),
                GpuRuntime = GpuRuntimeDetector.Probe(explicitPythonPath),
                ModelScan = !scanModels
                    ? new ModelScanResult { Mode = "skipped", Status = "not-scanned", Entries = 0, CompatibleCount = 0, Models = new List<ModelCandidate>(), Warnings = new List<string>() }
                    : string.IsNullOrWhiteSpace(explicitModelPath)
                    ? ModelDetector.Scan("quick", modelRoots, 5, 20000, 5000)
                    : ModelDetector.ScanSpecified(explicitModelPath)
            };

            try
            {
                result.Catalog = ResourceCatalog.Load(_resourcesRoot);
                result.CpuRuntime = result.Catalog.Validate(result.Catalog.FindCpuRuntime());
                result.VulkanRuntime = result.Catalog.Validate(result.Catalog.FindVulkanRuntime());
                ResourcePackage model = result.Catalog.FindRecommendedModel();
                result.RecommendedModel = result.Catalog.Validate(model);
                result.WhisperCppVadModel = result.Catalog.Validate(result.Catalog.FindRecommendedVadModel());
                if (model != null && !model.bundled && !result.RecommendedModel.IsValid)
                {
                    result.RecommendedModel.Error = "Not bundled. It may only be downloaded after explicit user consent.";
                }
            }
            catch (Exception exception)
            {
                result.Error = exception.Message;
            }

            return result;
        }

        public void Install(InstallOptions options, Action<string> report)
        {
            if (options == null) throw new ArgumentNullException("options");
            if (!Environment.Is64BitOperatingSystem) throw new PlatformNotSupportedException("This build supports Windows x64 only.");
            if (!options.QuickInstall && (options.InstallCpuRuntime || options.InstallVulkanRuntime || options.DownloadRecommendedModel))
                throw new InvalidOperationException("自定义安装不会下载模型或运行时，请使用本地已有环境。");
            if (!options.QuickInstall && options.InstallPremiere && string.IsNullOrWhiteSpace(options.ModelPath))
                throw new InvalidOperationException("自定义安装使用 PR/STT 时必须指定本地 Whisper 模型。");

            InspectionResult inspection = Inspect(options.HostExecutablePaths, options.QuickInstall ? null : options.ModelPath, options.PythonExecutablePath, !options.QuickInstall);
            EnsureSupportedHost(inspection.Hosts, options.InstallAfterEffects, options.InstallPremiere);
            EnsureComponentSelection(options);
            if (!options.QuickInstall && options.InstallPremiere
                && string.IsNullOrWhiteSpace(NormalizeSelectedModelPath(options.ModelPath, inspection.ModelScan)))
                throw new InvalidOperationException("自定义安装指定的 Whisper 模型无效或未被识别，请选择 GGML/GGUF、CTranslate2 或 Hugging Face 模型目录。");
            EnsureAdobeHostsAreClosed();
            if (inspection.Catalog == null) throw new InvalidDataException(inspection.Error ?? "External resources are unavailable.");

            ResourcePackage runtimePackage = inspection.Catalog.FindCpuRuntime();
            ResourcePackage vulkanPackage = inspection.Catalog.FindVulkanRuntime();
            ResourcePackage vadModelPackage = inspection.Catalog.FindRecommendedVadModel();
            bool sttRequested = options.InstallPremiere || options.DownloadRecommendedModel;
            bool hasExistingStt = !string.IsNullOrWhiteSpace(inspection.ExistingRuntimePath)
                || !string.IsNullOrWhiteSpace(inspection.ExistingVulkanRuntimePath)
                || inspection.GpuRuntime != null && inspection.GpuRuntime.Available;
            bool willInstallStt = options.InstallCpuRuntime || options.InstallVulkanRuntime;
            bool hasExistingCpu = !string.IsNullOrWhiteSpace(inspection.ExistingRuntimePath);
            if (options.QuickInstall && sttRequested && !hasExistingCpu && !options.InstallCpuRuntime)
                throw new InvalidOperationException("快速安装的 STT 默认需要 CPU whisper.cpp 运行时。");
            if (sttRequested && !hasExistingStt && !willInstallStt)
                throw new InvalidOperationException("选择 Premiere Pro 后，必须提供 CPU、Vulkan GPU/CPU 或现有 GPU Whisper 运行时。");
            if ((options.InstallCpuRuntime || options.InstallVulkanRuntime) && !options.LicenseAccepted)
                throw new InvalidOperationException("The third-party runtime license must be accepted before installation.");
            if (options.InstallCpuRuntime && (inspection.CpuRuntime == null || !inspection.CpuRuntime.IsValid))
                throw new InvalidDataException(inspection.CpuRuntime == null ? "CPU runtime is not declared." : inspection.CpuRuntime.Error);
            if (options.InstallVulkanRuntime && (inspection.VulkanRuntime == null || !inspection.VulkanRuntime.IsValid))
                throw new InvalidDataException(inspection.VulkanRuntime == null ? "Vulkan runtime is not declared." : inspection.VulkanRuntime.Error);
            if (options.QuickInstall && sttRequested
                && (vadModelPackage == null || !vadModelPackage.bundled
                    || inspection.WhisperCppVadModel == null || !inspection.WhisperCppVadModel.IsValid))
                throw new InvalidDataException(inspection.WhisperCppVadModel == null
                    ? "The bundled whisper.cpp VAD model is not declared."
                    : inspection.WhisperCppVadModel.Error);

            string downloadedModelPath = null;
            if (options.DownloadRecommendedModel)
            {
                downloadedModelPath = DownloadRecommendedModel(inspection.Catalog.FindRecommendedModel(), options.ModelDestinationFolder, report);
            }

            string installedRuntimePath = inspection.ExistingRuntimePath;
            string vadModelTarget = Path.Combine(_paths.VadRoot, "silero-vad.bin");
            string installedVadModelPath = File.Exists(vadModelTarget) ? vadModelTarget : null;
            InstallState previousState = LoadInstallState();
            bool previouslyOwnedVadModel = previousState != null && previousState.installWhisperCppVadModel;
            bool ownsVadModel = previouslyOwnedVadModel || options.QuickInstall && sttRequested;
            string managedVadModelSha256 = previousState == null ? null : previousState.whisperCppVadModelSha256;
            if (options.QuickInstall && sttRequested && vadModelPackage != null)
                managedVadModelSha256 = vadModelPackage.sha256;
            using (InstallTransaction transaction = new InstallTransaction())
            {
                try
                {
                    Report(report, "Preparing CEP extension...");
                    string extensionIncoming = transaction.CreateIncomingDirectory(_paths.ExtensionPath);
                    ExtractEmbeddedExtension(extensionIncoming);
                    ValidateExtensionPayload(extensionIncoming);
                    transaction.ReplaceDirectory(extensionIncoming, _paths.ExtensionPath);

                    if (options.InstallCpuRuntime)
                    {
                        Report(report, "Verifying and installing external CPU runtime...");
                        string runtimeTarget = Path.Combine(_paths.RuntimeRoot, runtimePackage.id);
                        string runtimeIncoming = transaction.CreateIncomingDirectory(runtimeTarget);
                        SafeZipExtractor.Extract(inspection.CpuRuntime.FullPath, runtimeIncoming);
                        installedRuntimePath = FindEntryPoint(runtimeIncoming, runtimePackage.entryPoint);
                        if (installedRuntimePath == null)
                            throw new InvalidDataException("Runtime archive does not contain " + runtimePackage.entryPoint + ".");
                        transaction.ReplaceDirectory(runtimeIncoming, runtimeTarget);
                        installedRuntimePath = FindEntryPoint(runtimeTarget, runtimePackage.entryPoint);
                        if (!WhisperRuntimeSelfTest.RunVerifiedArchiveSelfTest(installedRuntimePath))
                            throw new InvalidDataException("Installed runtime did not pass the whisper-cli compatibility probe.");
                    }

                    string installedVulkanRuntimePath = inspection.ExistingVulkanRuntimePath;
                    if (options.InstallVulkanRuntime)
                    {
                        Report(report, "Verifying and installing Vulkan GPU/CPU runtime...");
                        string vulkanTarget = Path.Combine(_paths.RuntimeRoot, vulkanPackage.id);
                        string vulkanIncoming = transaction.CreateIncomingDirectory(vulkanTarget);
                        SafeZipExtractor.Extract(inspection.VulkanRuntime.FullPath, vulkanIncoming);
                        installedVulkanRuntimePath = FindEntryPoint(vulkanIncoming, vulkanPackage.entryPoint);
                        if (installedVulkanRuntimePath == null)
                            throw new InvalidDataException("Vulkan runtime archive does not contain " + vulkanPackage.entryPoint + ".");
                        transaction.ReplaceDirectory(vulkanIncoming, vulkanTarget);
                        installedVulkanRuntimePath = FindEntryPoint(vulkanTarget, vulkanPackage.entryPoint);
                        if (!WhisperRuntimeSelfTest.RunVerifiedArchiveSelfTest(installedVulkanRuntimePath))
                            throw new InvalidDataException("Installed Vulkan runtime did not pass the whisper-cli compatibility probe.");
                    }

                    if (options.QuickInstall && sttRequested)
                    {
                        Report(report, "Verifying and installing the whisper.cpp Silero VAD model...");
                        transaction.ReplaceFile(inspection.WhisperCppVadModel.FullPath, vadModelTarget);
                        if (!File.Exists(vadModelTarget)
                            || new FileInfo(vadModelTarget).Length != vadModelPackage.size
                            || !string.Equals(ResourceCatalog.ComputeSha256(vadModelTarget), vadModelPackage.sha256, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidDataException("Installed whisper.cpp VAD model failed its integrity self-test.");
                        installedVadModelPath = vadModelTarget;
                    }

                    Report(report, "Installing resource provenance and licenses...");
                    string metadataIncoming = transaction.CreateIncomingDirectory(_paths.MetadataRoot);
                    CopyResourceMetadata(metadataIncoming, inspection.Catalog);
                    transaction.ReplaceDirectory(metadataIncoming, _paths.MetadataRoot);

                    Report(report, "Registering per-user installation...");
                    transaction.ReplaceFile(_executablePath, _paths.InstalledUninstallerPath);
                    InstallState state = new InstallState
                    {
                        productVersion = ProductInfo.Version,
                        installedAtUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        extensionPath = _paths.ExtensionPath,
                        installAfterEffects = options.InstallAfterEffects,
                        installPremiere = options.InstallPremiere,
                        installEffectCopy = options.InstallEffectCopy,
                        installCpuRuntime = options.InstallCpuRuntime,
                        installVulkanRuntime = options.InstallVulkanRuntime,
                        installWhisperCppVadModel = ownsVadModel,
                        runtimePath = installedRuntimePath,
                        runtimeId = options.InstallCpuRuntime && runtimePackage != null ? runtimePackage.id : null,
                        vulkanRuntimePath = installedVulkanRuntimePath,
                        whisperCppVadModelPath = ownsVadModel ? installedVadModelPath : null,
                        whisperCppVadModelSha256 = ownsVadModel ? managedVadModelSha256 : null,
                        pythonExecutablePath = inspection.GpuRuntime != null && inspection.GpuRuntime.Available ? inspection.GpuRuntime.PythonPath : null,
                        modelPath = downloadedModelPath ?? NormalizeSelectedModelPath(options.ModelPath, inspection.ModelScan),
                        modelDestinationFolder = options.ModelDestinationFolder,
                        uninstallerPath = _paths.InstalledUninstallerPath
                    };
                    string stateJson = new JavaScriptSerializer().Serialize(state);
                    transaction.WriteTextFile(_paths.InstallStatePath, stateJson);

                    transaction.SetRegistryValue(Registry.CurrentUser, CsxsRegistryPath, "PlayerDebugMode", "1", RegistryValueKind.String);
                    RegisterUninstaller(transaction);

                    if (!File.Exists(Path.Combine(_paths.ExtensionPath, "CSXS", "manifest.xml")))
                        throw new InvalidDataException("CEP extension self-test failed: CSXS/manifest.xml is missing.");
                    if (options.InstallCpuRuntime && string.IsNullOrWhiteSpace(installedRuntimePath))
                        throw new InvalidDataException("Runtime self-test failed: entry point is missing.");
                    if (options.InstallVulkanRuntime && string.IsNullOrWhiteSpace(installedVulkanRuntimePath))
                        throw new InvalidDataException("Vulkan runtime self-test failed: entry point is missing.");

                    transaction.Commit();
                    Report(report, "Installation complete. Restart Adobe applications before opening the panel.");
                }
                catch (Exception installError)
                {
                    Report(report, "Installation failed. Restoring the previous installation...");
                    try { transaction.Rollback(); }
                    catch (Exception rollbackError)
                    {
                        throw new AggregateException("Installation failed and rollback was incomplete.", installError, rollbackError);
                    }
                    throw;
                }
            }
        }

        public void Uninstall(Action<string> report)
        {
            EnsureAdobeHostsAreClosed();
            string currentExecutable = Path.GetFullPath(Assembly.GetExecutingAssembly().Location);
            InstallState installed = LoadInstallState();
            using (InstallTransaction transaction = new InstallTransaction())
            {
                try
                {
                    Report(report, "Removing CEP extension...");
                    transaction.RemoveDirectory(_paths.ExtensionPath);

                    Report(report, "Removing managed runtime and installer metadata...");
                    transaction.RemoveDirectory(_paths.RuntimeRoot);
                    if (installed != null && installed.installWhisperCppVadModel)
                    {
                        string managedVadPath = Path.Combine(_paths.VadRoot, "silero-vad.bin");
                        bool removeManagedVad = File.Exists(managedVadPath);
                        if (removeManagedVad && !string.IsNullOrWhiteSpace(installed.whisperCppVadModelSha256))
                        {
                            try
                            {
                                removeManagedVad = string.Equals(ResourceCatalog.ComputeSha256(managedVadPath),
                                    installed.whisperCppVadModelSha256, StringComparison.OrdinalIgnoreCase);
                            }
                            catch { removeManagedVad = false; }
                        }
                        if (removeManagedVad) transaction.RemoveFile(managedVadPath);
                    }
                    transaction.RemoveDirectory(_paths.MetadataRoot);
                    transaction.RemoveFile(_paths.InstallStatePath);
                    if (!string.Equals(currentExecutable, _paths.InstalledUninstallerPath, StringComparison.OrdinalIgnoreCase))
                        transaction.RemoveFile(_paths.InstalledUninstallerPath);

                    transaction.DeleteRegistryKey(Registry.CurrentUser, UninstallRegistryPath);
                    transaction.Commit();
                }
                catch (Exception uninstallError)
                {
                    Report(report, "Uninstall failed. Restoring removed components...");
                    try { transaction.Rollback(); }
                    catch (Exception rollbackError)
                    {
                        throw new AggregateException("Uninstall failed and rollback was incomplete.", uninstallError, rollbackError);
                    }
                    throw;
                }
            }

            if (string.Equals(currentExecutable, _paths.InstalledUninstallerPath, StringComparison.OrdinalIgnoreCase))
                NativeMethods.MoveFileEx(currentExecutable, null, NativeMethods.MoveFileFlags.DelayUntilReboot);

            // Models, settings, API credentials, and the shared CSXS PlayerDebugMode are intentionally preserved.
            Report(report, "Uninstall complete. User models and shared CEP debug settings were preserved.");
        }

        public bool IsInstalled()
        {
            return File.Exists(_paths.InstallStatePath) || Directory.Exists(_paths.ExtensionPath);
        }

        internal InstallState LoadInstallState()
        {
            try
            {
                if (!File.Exists(_paths.InstallStatePath)) return null;
                string json = File.ReadAllText(_paths.InstallStatePath);
                return new JavaScriptSerializer().Deserialize<InstallState>(json);
            }
            catch { return null; }
        }

        internal static string NormalizeSelectedModelPath(string requestedPath, ModelScanResult scan)
        {
            if (string.IsNullOrWhiteSpace(requestedPath) || scan == null || scan.Models == null || scan.Models.Count == 0) return null;
            string requestedFullPath;
            try { requestedFullPath = Path.GetFullPath(requestedPath); }
            catch { return null; }
            ModelCandidate first = null;
            for (int i = 0; i < scan.Models.Count; i++)
            {
                string candidate = scan.Models[i].Path;
                if (string.IsNullOrWhiteSpace(candidate)) continue;
                if (first == null) first = scan.Models[i];
                if (string.Equals(candidate, requestedFullPath, StringComparison.OrdinalIgnoreCase)) return requestedFullPath;
            }
            return first == null ? null : first.Path;
        }

        public void SelfTest()
        {
            ResourceCatalog catalog = ResourceCatalog.Load(_resourcesRoot);
            ResourceValidation runtime = catalog.Validate(catalog.FindCpuRuntime());
            if (runtime == null || !runtime.IsValid)
                throw new InvalidDataException(runtime == null ? "CPU runtime is not declared." : runtime.Error);

            string temp = Path.Combine(Path.GetTempPath(), "LocalWhisperSubtitles.Setup.SelfTest", Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(temp);
                ExtractEmbeddedExtension(temp);
                ValidateExtensionPayload(temp);
            }
            finally
            {
                SafeFileSystem.DeleteDirectory(temp);
            }
        }

        private void ExtractEmbeddedExtension(string destination)
        {
            Assembly assembly = Assembly.GetExecutingAssembly();
            using (Stream stream = assembly.GetManifestResourceStream(ExtensionResourceName))
            {
                if (stream == null) throw new InvalidDataException("Setup does not contain the CEP extension payload.");
                SafeZipExtractor.Extract(stream, destination);
            }
        }

        private static void ValidateExtensionPayload(string directory)
        {
            string manifest = Path.Combine(directory, "CSXS", "manifest.xml");
            string index = Path.Combine(directory, "index.html");
            if (!File.Exists(manifest) || !File.Exists(index))
                throw new InvalidDataException("Embedded CEP payload is incomplete.");
        }

        private void CopyResourceMetadata(string destination, ResourceCatalog catalog)
        {
            File.Copy(Path.Combine(catalog.Root, "manifest.json"), Path.Combine(destination, "manifest.json"), true);
            string licenseRoot = Path.Combine(catalog.Root, "licenses");
            if (!Directory.Exists(licenseRoot)) return;
            string[] files = Directory.GetFiles(licenseRoot, "*", SearchOption.AllDirectories);
            for (int i = 0; i < files.Length; i++)
            {
                string relative = files[i].Substring(licenseRoot.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                string target = PathSafety.ResolveChildPath(Path.Combine(destination, "licenses"), relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                File.Copy(files[i], target, true);
            }
        }

        private void RegisterUninstaller(InstallTransaction transaction)
        {
            Dictionary<string, RegistryEntry> values = new Dictionary<string, RegistryEntry>(StringComparer.OrdinalIgnoreCase);
            values["DisplayName"] = new RegistryEntry(ProductInfo.Name, RegistryValueKind.String);
            values["DisplayVersion"] = new RegistryEntry(ProductInfo.Version, RegistryValueKind.String);
            values["Publisher"] = new RegistryEntry("Local Whisper Subtitles", RegistryValueKind.String);
            values["InstallLocation"] = new RegistryEntry(_paths.InstallRoot, RegistryValueKind.String);
            values["DisplayIcon"] = new RegistryEntry(_paths.InstalledUninstallerPath, RegistryValueKind.String);
            values["UninstallString"] = new RegistryEntry(Quote(_paths.InstalledUninstallerPath) + " --uninstall", RegistryValueKind.String);
            values["QuietUninstallString"] = new RegistryEntry(Quote(_paths.InstalledUninstallerPath) + " --uninstall --quiet", RegistryValueKind.String);
            values["NoModify"] = new RegistryEntry(1, RegistryValueKind.DWord);
            values["NoRepair"] = new RegistryEntry(1, RegistryValueKind.DWord);
            transaction.ReplaceRegistryKey(Registry.CurrentUser, UninstallRegistryPath, values);
        }

        private static string FindEntryPoint(string root, string entryPoint)
        {
            if (string.IsNullOrWhiteSpace(entryPoint)) return null;
            string[] files = Directory.GetFiles(root, Path.GetFileName(entryPoint), SearchOption.AllDirectories);
            return files.Length > 0 ? files[0] : null;
        }

        private static string DownloadRecommendedModel(ResourcePackage package, string destinationFolder, Action<string> report)
        {
            if (package == null) throw new InvalidDataException("推荐 Whisper 模型未在资源清单中声明。");
            if (string.IsNullOrWhiteSpace(destinationFolder))
                throw new InvalidOperationException("快速安装需要先选择 Whisper 模型保存文件夹。");
            Uri source;
            if (!Uri.TryCreate(package.downloadUrl, UriKind.Absolute, out source) || source.Scheme != Uri.UriSchemeHttps)
                throw new InvalidDataException("推荐模型下载地址必须是 HTTPS。");
            if (package.size <= 0 || string.IsNullOrWhiteSpace(package.sha256) || package.sha256.Length != 64)
                throw new InvalidDataException("推荐模型缺少可验证的大小或 SHA-256 信息。");

            string folder = Path.GetFullPath(destinationFolder);
            Directory.CreateDirectory(folder);
            string fileName = Path.GetFileName(package.localPath);
            if (string.IsNullOrWhiteSpace(fileName) || fileName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
                throw new InvalidDataException("推荐模型文件名无效。");
            string target = Path.Combine(folder, fileName);
            string partial = target + ".part";
            try
            {
                Report(report, "正在下载推荐 Whisper 模型（" + FormatBytes(package.size) + "）...");
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(source);
                request.Method = "GET";
                request.UserAgent = "LocalWhisperSubtitles-ModelDownload/" + ProductInfo.Version;
                request.Timeout = 30000;
                request.ReadWriteTimeout = 30000;
                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream input = response.GetResponseStream())
                using (FileStream output = new FileStream(partial, FileMode.Create, FileAccess.Write, FileShare.None))
                using (System.Security.Cryptography.SHA256 hash = System.Security.Cryptography.SHA256.Create())
                {
                    byte[] buffer = new byte[1024 * 1024];
                    long total = 0;
                    int read;
                    int lastPercent = -1;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        output.Write(buffer, 0, read);
                        hash.TransformBlock(buffer, 0, read, buffer, 0);
                        total += read;
                        int percent = (int)Math.Min(100, total * 100L / package.size);
                        if (percent != lastPercent)
                        {
                            lastPercent = percent;
                            Report(report, "正在下载推荐 Whisper 模型... " + percent + "%");
                        }
                    }
                    hash.TransformFinalBlock(new byte[0], 0, 0);
                    string actualHash = BitConverter.ToString(hash.Hash).Replace("-", string.Empty).ToLowerInvariant();
                    if (total != package.size || !string.Equals(actualHash, package.sha256, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidDataException("下载的推荐模型大小或 SHA-256 校验失败，未安装该文件。");
                }
                if (File.Exists(target)) File.Replace(partial, target, null);
                else File.Move(partial, target);
                return target;
            }
            finally
            {
                try { if (File.Exists(partial)) File.Delete(partial); } catch { }
            }
        }

        private static string FormatBytes(long value)
        {
            if (value >= 1024L * 1024L * 1024L) return (value / 1073741824.0).ToString("0.0", CultureInfo.InvariantCulture) + " GB";
            return (value / 1048576.0).ToString("0", CultureInfo.InvariantCulture) + " MB";
        }

        private static void EnsureSupportedHost(List<HostInstallation> hosts, bool installAfterEffects, bool installPremiere)
        {
            if (!installAfterEffects && !installPremiere)
                throw new InvalidOperationException("请至少选择 After Effects 或 Premiere Pro。");
            for (int i = 0; i < hosts.Count; i++)
            {
                if (installAfterEffects && string.Equals(hosts[i].HostCode, "AEFT", StringComparison.OrdinalIgnoreCase) && hosts[i].Supported) installAfterEffects = false;
                if (installPremiere && string.Equals(hosts[i].HostCode, "PPRO", StringComparison.OrdinalIgnoreCase) && hosts[i].Supported) installPremiere = false;
            }
            if (installAfterEffects || installPremiere)
                throw new InvalidOperationException("所选 Adobe 宿主未检测到受支持的 2020+ 版本。");
        }

        private static void EnsureComponentSelection(InstallOptions options)
        {
            if (options.InstallAfterEffects && !options.InstallEffectCopy)
                throw new InvalidOperationException("After Effects requires the effect-copy component.");
            if (!options.InstallAfterEffects && options.InstallEffectCopy)
                throw new InvalidOperationException("The effect-copy component can only be installed with After Effects.");
        }

        private static void EnsureAdobeHostsAreClosed()
        {
            string[] names = new string[] { "AfterFX", "Adobe Premiere Pro" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] processes = Process.GetProcessesByName(names[i]);
                try
                {
                    if (processes.Length > 0) throw new InvalidOperationException("Close After Effects and Premiere Pro before continuing.");
                }
                finally
                {
                    for (int p = 0; p < processes.Length; p++) processes[p].Dispose();
                }
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }

        private static void Report(Action<string> report, string message)
        {
            if (report != null) report(message);
        }
    }

    internal static class NativeMethods
    {
        [Flags]
        internal enum MoveFileFlags
        {
            DelayUntilReboot = 0x4
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool MoveFileEx(string existingFileName, string newFileName, MoveFileFlags flags);
    }
}
