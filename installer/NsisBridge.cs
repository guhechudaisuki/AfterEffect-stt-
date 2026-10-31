using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace LocalWhisperSubtitles.Setup
{
    // NSIS owns every page. This process inspects or performs one explicit
    // operation, communicating through Unicode INI files, never a second UI.
    internal static class NsisBridge
    {
        public static int Run(string[] args)
        {
            string executable = System.Reflection.Assembly.GetExecutingAssembly().Location;
            string resources = Argument(args, "--resources-root") ?? Path.Combine(Path.GetDirectoryName(executable), "resources");
            string report = Argument(args, "--report");
            string request = Argument(args, "--request");
            try
            {
                resources = Path.GetFullPath(resources);
                if (!string.IsNullOrWhiteSpace(report)) report = Path.GetFullPath(report);
                if (!string.IsNullOrWhiteSpace(request)) request = Path.GetFullPath(request);
                if (Directory.Exists(Path.GetDirectoryName(resources))) Environment.CurrentDirectory = Path.GetDirectoryName(resources);
                InstallerEngine engine = new InstallerEngine(executable, resources, AppPaths.ForCurrentUser());
                if (Has(args, "--self-test")) { engine.SelfTest(); return 0; }
                if (Has(args, "--uninstall-cli")) { engine.Uninstall(Console.WriteLine); return 0; }
                if (string.IsNullOrWhiteSpace(request) || !File.Exists(request)) throw new InvalidDataException("Run Setup.exe to choose installation options.");
                InstallOptions options = ReadOptions(request);
                if (Has(args, "--install-cli"))
                {
                    if (!File.Exists(options.NativeUninstallerPath)) throw new InvalidDataException("Native NSIS uninstaller is missing.");
                    engine.Install(options, Console.WriteLine);
                    Write(report, "result", "success", "1");
                    return 0;
                }
                if (!Has(args, "--inspect-cli")) throw new InvalidDataException("Unknown installer operation.");
                InspectionResult result = engine.Inspect(options.HostExecutablePaths, options.ModelPath, options.PythonExecutablePath, !options.QuickInstall, options.ToolSearchFolder, Read(request, "fullScan") == "1");
                WriteInspection(result, options, report);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.Message);
                try { if (!string.IsNullOrWhiteSpace(report)) Write(report, "result", "error", error.Message); } catch { }
                return 1;
            }
        }

        internal static InstallOptions ReadOptions(string file)
        {
            bool quick = Read(file, "quick", "1") == "1";
            bool ae = Read(file, "ae", "1") == "1", pr = Read(file, "pr", "0") == "1";
            bool stt = pr || Read(file, "stt", "0") == "1";
            return new InstallOptions {
                QuickInstall = quick, InstallAfterEffects = ae, InstallPremiere = pr, InstallEffectCopy = ae,
                InstallCpuRuntime = quick && stt, InstallVulkanRuntime = quick && stt && Read(file, "gpu") == "1",
                DownloadRecommendedModel = quick && stt, LicenseAccepted = Read(file, "license") == "1",
                ModelDestinationFolder = Read(file, "modelFolder"), ModelPath = quick ? null : NullIfEmpty(Read(file, "modelPath")),
                PythonExecutablePath = quick ? null : NullIfEmpty(Read(file, "pythonPath")), ToolSearchFolder = NullIfEmpty(Read(file, "toolFolder")),
                NativeUninstallerPath = NullIfEmpty(Read(file, "uninstaller")),
                HostExecutablePaths = new string[] { Read(file, "aePath"), Read(file, "prPath") }
            };
        }

        private static void WriteInspection(InspectionResult result, InstallOptions options, string output)
        {
            if (string.IsNullOrWhiteSpace(output)) throw new InvalidDataException("Inspection report path is required.");
            if (File.Exists(output)) File.Delete(output);
            bool hostsReady = options.InstallAfterEffects || options.InstallPremiere;
            foreach (HostInstallation host in result.Hosts)
            {
                Write(output, "hosts", host.HostCode, host.Supported ? "1" : "0");
                Write(output, "hosts", host.HostCode + "Path", host.ExecutablePath);
                Write(output, "hosts", host.HostCode + "Status", host.Supported ? host.DisplayName + " " + host.Version + " 可用" : host.DisplayName + "：" + host.Status);
                if ((host.HostCode == "AEFT" && options.InstallAfterEffects || host.HostCode == "PPRO" && options.InstallPremiere) && !host.Supported) hostsReady = false;
            }
            ModelCandidate preferred = null;
            string saved = InstallerEngine.NormalizeSelectedModelPath(options.ModelPath ?? LocalResourceHints.ForCurrentUser().PreferredModelPath, result.ModelScan);
            int index = 0;
            foreach (ModelCandidate model in result.ModelScan.Models)
            {
                bool compatible = RuntimeCompatibility.CanRun(model, result);
                string section = "model" + index++;
                Write(output, section, "path", model.Path);
                Write(output, section, "format", model.Format);
                Write(output, section, "usable", compatible ? "1" : "0");
                if (preferred == null && compatible || string.Equals(model.Path, saved, StringComparison.OrdinalIgnoreCase)) preferred = model;
            }
            bool modelReady = preferred != null && RuntimeCompatibility.CanRun(preferred, result);
            string python = preferred == null || result.GpuRuntime == null ? null : result.GpuRuntime.PythonForModel(preferred.Format);
            Write(output, "resources", "modelCount", index.ToString());
            Write(output, "resources", "scanStatus", result.ModelScan.Status);
            Write(output, "resources", "modelPath", preferred == null ? null : preferred.Path);
            Write(output, "resources", "modelUsable", modelReady ? "1" : "0");
            Write(output, "resources", "pythonPath", python ?? (result.GpuRuntime == null ? null : result.GpuRuntime.PythonPath));
            Write(output, "resources", "cpuPath", result.ExistingRuntimePath);
            Write(output, "resources", "vulkanPath", result.ExistingVulkanRuntimePath);
            Write(output, "resources", "ffmpegPath", result.FfmpegPath);
            Write(output, "resources", "cpuStatus", result.ExistingRuntimePath != null ? "CPU whisper.cpp：" + result.ExistingRuntimePath : result.GpuRuntime != null && result.GpuRuntime.PythonWhisperCpu ? "Python CPU Whisper：可用" : "CPU 运行时：未找到可用环境");
            Write(output, "resources", "gpuStatus", result.ExistingVulkanRuntimePath != null ? "Vulkan GPU+CPU：" + result.ExistingVulkanRuntimePath : result.GpuRuntime == null ? "GPU：未检测" : result.GpuRuntime.Detail);
            Write(output, "resources", "modelStatus", options.QuickInstall ? "快速安装不扫描本地模型，确认后下载推荐模型。" : "找到 " + index + " 个模型；" + (modelReady ? "已匹配可用环境" : "请选择模型或指定环境目录") + (result.ModelScan.Status == "partial" ? "（扫描达到限制，并非全盘无模型）" : ""));
            Write(output, "resources", "error", result.Error);
            Write(output, "result", "hostsReady", hostsReady ? "1" : "0");
            Write(output, "result", "ready", hostsReady && (options.QuickInstall || !options.InstallPremiere || modelReady) && result.Catalog != null ? "1" : "0");
            Write(output, "result", "success", "1");
        }

        private static bool Has(string[] args, string name) { return Array.Exists(args, delegate(string item) { return string.Equals(item, name, StringComparison.OrdinalIgnoreCase); }); }
        private static string Argument(string[] args, string name) { for (int i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1]; return null; }
        private static string NullIfEmpty(string value) { return string.IsNullOrWhiteSpace(value) ? null : value; }
        internal static string Read(string file, string key, string fallback = "")
        {
            StringBuilder buffer = new StringBuilder(32768);
            GetPrivateProfileString("options", key, fallback, buffer, buffer.Capacity, file);
            return buffer.ToString();
        }
        internal static void Write(string file, string section, string key, string value)
        {
            if (string.IsNullOrWhiteSpace(file)) return;
            if (!File.Exists(file)) { Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file))); File.WriteAllText(file, "; Local Whisper Subtitles\r\n", Encoding.Unicode); }
            if (!WritePrivateProfileString(section, key, (value ?? "").Replace("\r", " ").Replace("\n", " "), file)) throw new IOException("Unable to save installer report.");
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
        private static extern uint GetPrivateProfileString(string section, string key, string fallback, StringBuilder buffer, int size, string file);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool WritePrivateProfileString(string section, string key, string value, string file);
    }
}
