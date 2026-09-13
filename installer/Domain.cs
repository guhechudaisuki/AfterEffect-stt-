using System;
using System.Collections.Generic;
using System.IO;

namespace LocalWhisperSubtitles.Setup
{
    internal static class ProductInfo
    {
        public const string Name = "Local Whisper Subtitles";
        public const string Version = "4.0.1";
        public const string ExtensionId = "com.localwhisper.subtitles";
        public const int MinimumSupportedAfterEffectsMajor = 17;
        public const int MinimumSupportedPremiereMajor = 14;

        public static bool IsSupportedHostVersion(string hostCode, int major, int minor)
        {
            int requiredMajor = string.Equals(hostCode, "PPRO", StringComparison.OrdinalIgnoreCase)
                ? MinimumSupportedPremiereMajor
                : MinimumSupportedAfterEffectsMajor;
            return major >= requiredMajor;
        }

        public static string SupportedHostLabel(string hostCode)
        {
            return string.Equals(hostCode, "PPRO", StringComparison.OrdinalIgnoreCase)
                ? "Premiere Pro 2020（14.x）及以后版本"
                : "After Effects 2020（17.x）及以后版本";
        }
    }

    internal sealed class AppPaths
    {
        public string ExtensionPath { get; private set; }
        public string InstallRoot { get; private set; }
        public string RuntimeRoot { get; private set; }
        public string VadRoot { get; private set; }
        public string MetadataRoot { get; private set; }
        public string InstallStatePath { get; private set; }
        public string InstalledUninstallerPath { get; private set; }

        public static AppPaths ForCurrentUser()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string installRoot = Path.Combine(localAppData, "LocalWhisperSubtitles");

            return new AppPaths
            {
                ExtensionPath = Path.Combine(appData, "Adobe", "CEP", "extensions", ProductInfo.ExtensionId),
                InstallRoot = installRoot,
                RuntimeRoot = Path.Combine(installRoot, "runtime"),
                VadRoot = Path.Combine(installRoot, "vad"),
                MetadataRoot = Path.Combine(installRoot, "resources"),
                InstallStatePath = Path.Combine(installRoot, "install-state.json"),
                InstalledUninstallerPath = Path.Combine(installRoot, "Uninstall.exe")
            };
        }
    }

    public sealed class ResourceManifest
    {
        public string schemaVersion { get; set; }
        public string productVersion { get; set; }
        public string generatedAt { get; set; }
        public string integrityAlgorithm { get; set; }
        public List<ResourcePackage> runtimes { get; set; }
        public List<ResourcePackage> models { get; set; }
        public List<ResourcePackage> vadModels { get; set; }
        public List<ResourceLicense> licenses { get; set; }
    }

    public sealed class ResourcePackage
    {
        public string id { get; set; }
        public string displayName { get; set; }
        public string version { get; set; }
        public string kind { get; set; }
        public string backend { get; set; }
        public string architecture { get; set; }
        public string format { get; set; }
        public string localPath { get; set; }
        public string entryPoint { get; set; }
        public string sha256 { get; set; }
        public long size { get; set; }
        public bool bundled { get; set; }
        public bool required { get; set; }
        public bool recommended { get; set; }
        public string downloadUrl { get; set; }
        public string sourceUrl { get; set; }
        public List<string> licenseIds { get; set; }
    }

    public sealed class ResourceLicense
    {
        public string id { get; set; }
        public string component { get; set; }
        public string spdxId { get; set; }
        public string textPath { get; set; }
        public string sourceUrl { get; set; }
    }

    internal sealed class ResourceValidation
    {
        public ResourcePackage Package { get; set; }
        public bool IsValid { get; set; }
        public string FullPath { get; set; }
        public string Error { get; set; }
    }

    internal sealed class HostInstallation
    {
        public string HostCode { get; set; }
        public string DisplayName { get; set; }
        public string ExecutablePath { get; set; }
        public string Version { get; set; }
        public bool Found { get; set; }
        public bool Supported { get; set; }
        public string Status { get; set; }
    }

    internal sealed class InspectionResult
    {
        public List<HostInstallation> Hosts { get; set; }
        public ResourceCatalog Catalog { get; set; }
        public ResourceValidation CpuRuntime { get; set; }
        public ResourceValidation VulkanRuntime { get; set; }
        public ResourceValidation RecommendedModel { get; set; }
        public ResourceValidation WhisperCppVadModel { get; set; }
        public string ExistingRuntimePath { get; set; }
        public string ExistingVulkanRuntimePath { get; set; }
        public GpuRuntimeStatus GpuRuntime { get; set; }
        public ModelScanResult ModelScan { get; set; }
        public string Error { get; set; }
    }

    internal sealed class ModelScanResult
    {
        public string Mode { get; set; }
        public string Status { get; set; }
        public int Entries { get; set; }
        public int CompatibleCount { get; set; }
        public List<ModelCandidate> Models { get; set; }
        public List<string> Warnings { get; set; }
    }

    internal sealed class ModelCandidate
    {
        public string Path { get; set; }
        public string DisplayName { get; set; }
        public string Format { get; set; }
        public long SizeBytes { get; set; }
        public bool CompatibleWithWhisperCpp { get; set; }
        public string CompatibilityReason { get; set; }
        public string Origin { get; set; }
    }

    internal sealed class InstallOptions
    {
        public bool QuickInstall { get; set; }
        public bool InstallAfterEffects { get; set; }
        public bool InstallPremiere { get; set; }
        public bool InstallEffectCopy { get; set; }
        public bool InstallCpuRuntime { get; set; }
        public bool InstallVulkanRuntime { get; set; }
        public bool DownloadRecommendedModel { get; set; }
        public bool LicenseAccepted { get; set; }
        public string[] HostExecutablePaths { get; set; }
        public string PythonExecutablePath { get; set; }
        public string ModelPath { get; set; }
        public string ModelDestinationFolder { get; set; }
    }

    internal sealed class InstallState
    {
        public string productVersion { get; set; }
        public string installedAtUtc { get; set; }
        public string extensionPath { get; set; }
        public bool installAfterEffects { get; set; }
        public bool installPremiere { get; set; }
        public bool installEffectCopy { get; set; }
        public bool installCpuRuntime { get; set; }
        public bool installVulkanRuntime { get; set; }
        public bool installWhisperCppVadModel { get; set; }
        public string runtimePath { get; set; }
        public string runtimeId { get; set; }
        public string vulkanRuntimePath { get; set; }
        public string whisperCppVadModelPath { get; set; }
        public string whisperCppVadModelSha256 { get; set; }
        public string pythonExecutablePath { get; set; }
        public string modelPath { get; set; }
        public string modelDestinationFolder { get; set; }
        public string uninstallerPath { get; set; }
    }

    internal static class PathSafety
    {
        public static string ResolveChildPath(string root, string relativePath)
        {
            if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("Root path is required.", "root");
            if (string.IsNullOrWhiteSpace(relativePath)) throw new ArgumentException("Relative path is required.", "relativePath");
            if (Path.IsPathRooted(relativePath)) throw new InvalidDataException("Absolute resource paths are not allowed.");

            string fullRoot = EnsureTrailingSeparator(Path.GetFullPath(root));
            string fullPath = Path.GetFullPath(Path.Combine(fullRoot, relativePath));
            if (!fullPath.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException("Resource path escapes its declared root: " + relativePath);
            }

            return fullPath;
        }

        public static bool IsSameOrChild(string root, string candidate)
        {
            string fullRoot = EnsureTrailingSeparator(Path.GetFullPath(root));
            string fullCandidate = Path.GetFullPath(candidate);
            return fullCandidate.Equals(fullRoot.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
                || fullCandidate.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase);
        }

        private static string EnsureTrailingSeparator(string path)
        {
            if (!path.EndsWith(Path.DirectorySeparatorChar.ToString(), StringComparison.Ordinal))
            {
                path += Path.DirectorySeparatorChar;
            }
            return path;
        }
    }
}
