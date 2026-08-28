using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace LocalWhisperSubtitles.Setup
{
    internal sealed class GpuRuntimeStatus
    {
        public bool NvidiaDriver { get; set; }
        public bool CudaToolkit { get; set; }
        public bool PythonWhisperGpu { get; set; }
        public bool TorchCuda { get; set; }
        public bool OpenAiWhisper { get; set; }
        public bool FasterWhisper { get; set; }
        public bool TransformersWhisper { get; set; }
        public bool CTranslate2Cuda { get; set; }
        public string PythonPath { get; set; }
        public string TorchCudaPythonPath { get; set; }
        public string Backend { get; set; }
        public string Detail { get; set; }
        public bool Available { get { return PythonWhisperGpu; } }
    }

    internal static class GpuRuntimeDetector
    {
        private static readonly string[] CondaDirectoryNames = new string[]
        {
            "Miniconda", "Miniconda3", "Anaconda", "Anaconda3", "Mambaforge", "Miniforge", "Miniforge3"
        };

        public static GpuRuntimeStatus Probe()
        {
            return Probe(null);
        }

        public static GpuRuntimeStatus Probe(string explicitPythonPath)
        {
            GpuRuntimeStatus result = new GpuRuntimeStatus
            {
                NvidiaDriver = ProbeNvidiaDriver(),
                CudaToolkit = ProbeCudaToolkit(),
                Detail = "\u672A\u68C0\u6D4B\u5230\u53EF\u8C03\u7528\u7684 Python GPU Whisper \u8FD0\u884C\u65F6\u3002"
            };
            if (!result.NvidiaDriver)
            {
                result.Detail = "\u672A\u68C0\u6D4B\u5230 NVIDIA \u9A71\u52A8\u6216 nvidia-smi\uFF1B\u53EF\u8DF3\u8FC7 GPU\uFF0C\u4F7F\u7528 CPU\u3002";
                return result;
            }

            IEnumerable<string> candidates = string.IsNullOrWhiteSpace(explicitPythonPath)
                ? PythonCandidates()
                : FindPythonCandidates(new string[] { explicitPythonPath }, false);
            foreach (string python in candidates)
            {
                PythonProbe probe = ProbePython(python);
                if (!probe.Ready) continue;

                result.OpenAiWhisper = result.OpenAiWhisper || probe.OpenAiWhisper;
                result.FasterWhisper = result.FasterWhisper || probe.FasterWhisper;
                result.TransformersWhisper = result.TransformersWhisper || probe.Transformers;
                result.CTranslate2Cuda = result.CTranslate2Cuda || probe.CTranslate2Cuda;
                if (probe.TorchCuda)
                {
                    result.TorchCuda = true;
                    if (string.IsNullOrWhiteSpace(result.TorchCudaPythonPath)) result.TorchCudaPythonPath = python;
                }

                if (probe.OpenAiWhisper && probe.TorchCuda)
                {
                    result.PythonWhisperGpu = true;
                    result.PythonPath = python;
                    result.Backend = "OpenAI Whisper + PyTorch CUDA";
                    result.Detail = "\u5DF2\u68C0\u6D4B\u5230\u672C\u5730 PyTorch CUDA \u548C OpenAI Whisper\uFF0C\u53EF\u76F4\u63A5\u4F7F\u7528 GPU\u3002";
                    return result;
                }
                if (probe.FasterWhisper && probe.CTranslate2Cuda)
                {
                    result.PythonWhisperGpu = true;
                    result.PythonPath = python;
                    result.Backend = "faster-whisper + CTranslate2 CUDA";
                    result.Detail = "\u5DF2\u68C0\u6D4B\u5230\u672C\u5730 faster-whisper CUDA\uFF0C\u53EF\u76F4\u63A5\u4F7F\u7528 GPU\u3002";
                    return result;
                }
                if (probe.Transformers && probe.TorchCuda)
                {
                    result.PythonWhisperGpu = true;
                    result.PythonPath = python;
                    result.Backend = "Transformers Whisper + PyTorch CUDA";
                    result.Detail = "\u5DF2\u68C0\u6D4B\u5230\u672C\u5730 Transformers Whisper \u548C PyTorch CUDA\uFF0C\u53EF\u76F4\u63A5\u4F7F\u7528 GPU\u3002";
                    return result;
                }
            }

            result.Detail = DescribeUnavailable(result);
            return result;
        }

        // Kept internal so installer tests can cover non-standard Conda installation roots.
        internal static List<string> FindPythonCandidates(IEnumerable<string> roots, bool includePath)
        {
            List<string> result = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (includePath)
            {
                string path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
                string[] directories = path.Split(new char[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
                for (int i = 0; i < directories.Length; i++) AddPythonFromRoot(result, seen, directories[i]);
            }
            if (roots != null)
            {
                foreach (string root in roots) AddPythonFromRoot(result, seen, root);
            }
            return result;
        }

        private static string DescribeUnavailable(GpuRuntimeStatus result)
        {
            if (result.TorchCuda)
            {
                return "\u5DF2\u68C0\u6D4B\u5230 PyTorch CUDA\uFF08" + result.TorchCudaPythonPath + "\uFF09\uFF0C\u4F46\u8BE5 Python \u73AF\u5883\u672A\u68C0\u6D4B\u5230 OpenAI Whisper \u6216 faster-whisper\uFF1B\u56E0\u6B64\u65E0\u6CD5\u8FDB\u884C\u8BED\u97F3\u8BC6\u522B\u3002";
            }
            if (result.OpenAiWhisper || result.FasterWhisper)
            {
                return "\u5DF2\u68C0\u6D4B\u5230 Python Whisper \u8BED\u97F3\u8BC6\u522B\u5F15\u64CE\uFF0C\u4F46\u672A\u68C0\u6D4B\u5230\u53EF\u7528\u7684 CUDA \u8BA1\u7B97\u540E\u7AEF\uFF1B\u53EF\u8DF3\u8FC7 GPU\u5E76\u4F7F\u7528 CPU\u3002";
            }
            if (result.TransformersWhisper)
            {
                return "\u5DF2\u68C0\u6D4B\u5230 Transformers\uFF0C\u4F46\u672A\u68C0\u6D4B\u5230 PyTorch CUDA\uFF1B\u53EF\u8DF3\u8FC7 GPU\u5E76\u4F7F\u7528 CPU\u3002";
            }
            return result.CudaToolkit
                ? "\u5DF2\u68C0\u6D4B\u5230 NVIDIA/CUDA\uFF0C\u4F46\u672A\u68C0\u6D4B\u5230 OpenAI Whisper + PyTorch CUDA \u6216 faster-whisper + CTranslate2 CUDA \u8FD0\u884C\u65F6\uFF1B\u53EF\u8DF3\u8FC7\u5E76\u4F7F\u7528 CPU\u3002"
                : "\u5DF2\u68C0\u6D4B\u5230 NVIDIA \u9A71\u52A8\uFF0C\u4F46\u672A\u68C0\u6D4B\u5230 CUDA GPU \u8FD0\u884C\u65F6\uFF1B\u53EF\u8DF3\u8FC7\u5E76\u4F7F\u7528 CPU\u3002";
        }

        private static bool ProbeNvidiaDriver()
        {
            ProcessResult result = Run("nvidia-smi.exe", "--query-gpu=name --format=csv,noheader,nounits", 4000);
            return result.ExitCode == 0 && !string.IsNullOrWhiteSpace(result.Stdout);
        }

        private static bool ProbeCudaToolkit()
        {
            string root = Environment.GetEnvironmentVariable("CUDA_PATH");
            if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return false;
            string bin = Path.Combine(root, "bin");
            return File.Exists(Path.Combine(bin, "nvcc.exe")) ||
                File.Exists(Path.Combine(bin, "cudart64_12.dll")) ||
                File.Exists(Path.Combine(bin, "cudart64_11.dll"));
        }

        private static IEnumerable<string> PythonCandidates()
        {
            return FindPythonCandidates(DiscoverPythonRoots(), true);
        }

        private static List<string> DiscoverPythonRoots()
        {
            List<string> roots = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            string user = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string programData = Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData);

            AddRoot(roots, seen, Path.Combine(local, "Programs", "Python"));
            if (Directory.Exists(Path.Combine(local, "Programs", "Python")))
            {
                try
                {
                    foreach (string directory in Directory.GetDirectories(Path.Combine(local, "Programs", "Python"), "Python*")) AddRoot(roots, seen, directory);
                }
                catch { }
            }

            string condaPrefix = Environment.GetEnvironmentVariable("CONDA_PREFIX");
            AddRoot(roots, seen, condaPrefix);
            AddCondaEnvironmentList(roots, seen, Path.Combine(user, ".conda", "environments.txt"));
            AddCondaDirectoryNames(roots, seen, user);
            AddCondaDirectoryNames(roots, seen, local);
            AddCondaDirectoryNames(roots, seen, programData);
            AddCondaDirectoryNames(roots, seen, Path.GetPathRoot(Environment.SystemDirectory));
            AddRegistryPythonRoots(roots, seen);
            AddUninstallCondaRoots(roots, seen);
            AddFixedDriveCondaRoots(roots, seen);
            return roots;
        }

        private static void AddPythonFromRoot(List<string> result, HashSet<string> seen, string root)
        {
            if (string.IsNullOrWhiteSpace(root)) return;
            try
            {
                string expanded = Environment.ExpandEnvironmentVariables(root.Trim().Trim('"'));
                if (File.Exists(expanded))
                {
                    string fullFile = Path.GetFullPath(expanded);
                    if (fullFile.EndsWith("python.exe", StringComparison.OrdinalIgnoreCase) && seen.Add(fullFile)) result.Add(fullFile);
                    return;
                }
                string candidate = Path.Combine(expanded, "python.exe");
                if (File.Exists(candidate))
                {
                    candidate = Path.GetFullPath(candidate);
                    if (seen.Add(candidate)) result.Add(candidate);
                }
            }
            catch { }
        }

        private static void AddRoot(List<string> roots, HashSet<string> seen, string root)
        {
            if (string.IsNullOrWhiteSpace(root)) return;
            try
            {
                string full = Path.GetFullPath(root.Trim().Trim('"'));
                if (seen.Add(full)) roots.Add(full);
            }
            catch { }
        }

        private static void AddCondaDirectoryNames(List<string> roots, HashSet<string> seen, string parent)
        {
            if (string.IsNullOrWhiteSpace(parent)) return;
            for (int i = 0; i < CondaDirectoryNames.Length; i++) AddRoot(roots, seen, Path.Combine(parent, CondaDirectoryNames[i]));
        }

        private static void AddCondaEnvironmentList(List<string> roots, HashSet<string> seen, string file)
        {
            try
            {
                if (!File.Exists(file)) return;
                string[] lines = File.ReadAllLines(file);
                for (int i = 0; i < lines.Length; i++) AddRoot(roots, seen, lines[i]);
            }
            catch { }
        }

        private static void AddRegistryPythonRoots(List<string> roots, HashSet<string> seen)
        {
            AddRegistryPythonRoots(roots, seen, Registry.CurrentUser, @"Software\Python\PythonCore");
            AddRegistryPythonRoots(roots, seen, Registry.LocalMachine, @"Software\Python\PythonCore");
            AddRegistryPythonRoots(roots, seen, Registry.LocalMachine, @"Software\WOW6432Node\Python\PythonCore");
        }

        private static void AddRegistryPythonRoots(List<string> roots, HashSet<string> seen, RegistryKey hive, string path)
        {
            try
            {
                using (RegistryKey pythonCore = hive.OpenSubKey(path))
                {
                    if (pythonCore == null) return;
                    string[] versions = pythonCore.GetSubKeyNames();
                    for (int i = 0; i < versions.Length; i++)
                    {
                        using (RegistryKey install = pythonCore.OpenSubKey(versions[i] + "\\InstallPath"))
                        {
                            if (install != null) AddRoot(roots, seen, Convert.ToString(install.GetValue("")));
                        }
                    }
                }
            }
            catch { }
        }

        private static void AddUninstallCondaRoots(List<string> roots, HashSet<string> seen)
        {
            AddUninstallCondaRoots(roots, seen, Registry.CurrentUser, @"Software\Microsoft\Windows\CurrentVersion\Uninstall");
            AddUninstallCondaRoots(roots, seen, Registry.LocalMachine, @"Software\Microsoft\Windows\CurrentVersion\Uninstall");
            AddUninstallCondaRoots(roots, seen, Registry.LocalMachine, @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall");
        }

        private static void AddUninstallCondaRoots(List<string> roots, HashSet<string> seen, RegistryKey hive, string path)
        {
            try
            {
                using (RegistryKey uninstall = hive.OpenSubKey(path))
                {
                    if (uninstall == null) return;
                    string[] entries = uninstall.GetSubKeyNames();
                    for (int i = 0; i < entries.Length; i++)
                    {
                        using (RegistryKey entry = uninstall.OpenSubKey(entries[i]))
                        {
                            if (entry == null) continue;
                            string displayName = Convert.ToString(entry.GetValue("DisplayName"));
                            if (string.IsNullOrWhiteSpace(displayName) ||
                                (displayName.IndexOf("conda", StringComparison.OrdinalIgnoreCase) < 0 &&
                                displayName.IndexOf("forge", StringComparison.OrdinalIgnoreCase) < 0)) continue;
                            AddRoot(roots, seen, Convert.ToString(entry.GetValue("InstallLocation")));
                        }
                    }
                }
            }
            catch { }
        }

        private static void AddFixedDriveCondaRoots(List<string> roots, HashSet<string> seen)
        {
            DriveInfo[] drives;
            try { drives = DriveInfo.GetDrives(); }
            catch { return; }
            for (int i = 0; i < drives.Length; i++)
            {
                DriveInfo drive = drives[i];
                if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
                string[] firstLevel;
                try { firstLevel = Directory.GetDirectories(drive.RootDirectory.FullName); }
                catch { continue; }
                for (int d = 0; d < firstLevel.Length; d++)
                {
                    AddCondaDirectoryNames(roots, seen, firstLevel[d]);
                    string name = Path.GetFileName(firstLevel[d]);
                    if (IsCondaDirectoryName(name)) AddRoot(roots, seen, firstLevel[d]);
                }
            }
        }

        private static bool IsCondaDirectoryName(string name)
        {
            for (int i = 0; i < CondaDirectoryNames.Length; i++)
            {
                if (string.Equals(name, CondaDirectoryNames[i], StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        private static PythonProbe ProbePython(string python)
        {
            const string code = "import importlib.util as u,json\nresult={'whisper':bool(u.find_spec('whisper')),'faster':bool(u.find_spec('faster_whisper')),'transformers':bool(u.find_spec('transformers')),'ct2':False,'torch':False,'cuda':False}\ntry:\n import torch\n result['torch']=True\n result['cuda']=bool(torch.cuda.is_available())\nexcept Exception:\n pass\ntry:\n import ctranslate2 as c\n result['ct2']=bool(c.get_supported_compute_types('cuda'))\nexcept Exception:\n pass\nprint(json.dumps(result))";
            ProcessResult result = Run(python, "-c \"" + code.Replace("\"", "\\\"") + "\"", 30000);
            if (result.ExitCode != 0) return new PythonProbe();
            string compact = (result.Stdout ?? string.Empty).Replace(" ", string.Empty).Replace("\r", string.Empty).Replace("\n", string.Empty);
            return new PythonProbe
            {
                Ready = compact.IndexOf("{", StringComparison.Ordinal) >= 0,
                OpenAiWhisper = JsonTrue(compact, "whisper"),
                FasterWhisper = JsonTrue(compact, "faster"),
                Transformers = JsonTrue(compact, "transformers"),
                CTranslate2Cuda = JsonTrue(compact, "ct2"),
                TorchCuda = JsonTrue(compact, "cuda")
            };
        }

        private static bool JsonTrue(string json, string name)
        {
            return json.IndexOf("\"" + name + "\":true", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        private static ProcessResult Run(string fileName, string arguments, int timeoutMs)
        {
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(fileName, arguments)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = Environment.CurrentDirectory
                };
                using (Process process = Process.Start(start))
                {
                    if (process == null) return new ProcessResult { ExitCode = -1 };
                    string stdout = process.StandardOutput.ReadToEnd();
                    string stderr = process.StandardError.ReadToEnd();
                    if (!process.WaitForExit(timeoutMs))
                    {
                        try { process.Kill(); } catch { }
                        return new ProcessResult { ExitCode = -2, Stdout = stdout, Stderr = stderr };
                    }
                    return new ProcessResult { ExitCode = process.ExitCode, Stdout = stdout, Stderr = stderr };
                }
            }
            catch
            {
                return new ProcessResult { ExitCode = -1 };
            }
        }

        private sealed class ProcessResult
        {
            public int ExitCode;
            public string Stdout;
            public string Stderr;
        }

        private sealed class PythonProbe
        {
            public bool Ready;
            public bool OpenAiWhisper;
            public bool FasterWhisper;
            public bool Transformers;
            public bool CTranslate2Cuda;
            public bool TorchCuda;
        }
    }
}
