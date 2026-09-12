using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace LocalWhisperSubtitles.Setup
{
    internal static class HostDetector
    {
        private sealed class HostSpec
        {
            public string Code;
            public string DisplayName;
            public string[] RegistryNameFragments;
            public string[] ExecutableNames;
        }

        private static readonly HostSpec[] Specs = new HostSpec[]
        {
            new HostSpec
            {
                Code = "AEFT",
                DisplayName = "After Effects",
                RegistryNameFragments = new string[] { "Adobe After Effects" },
                ExecutableNames = new string[] { "AfterFX.exe" }
            },
            new HostSpec
            {
                Code = "PPRO",
                DisplayName = "Premiere Pro",
                RegistryNameFragments = new string[] { "Adobe Premiere Pro" },
                ExecutableNames = new string[] { "Adobe Premiere Pro.exe" }
            }
        };

        public static List<HostInstallation> DetectSupportedHosts()
        {
            return DetectSupportedHosts(null);
        }

        public static List<HostInstallation> DetectSupportedHosts(IEnumerable<string> explicitExecutablePaths)
        {
            List<string> registryInstallLocations = ReadAdobeInstallLocations();
            List<HostInstallation> result = new List<HostInstallation>();
            for (int i = 0; i < Specs.Length; i++) result.Add(DetectHost(Specs[i], registryInstallLocations, explicitExecutablePaths));
            return result;
        }

        private static HostInstallation DetectHost(HostSpec spec, List<string> registryLocations, IEnumerable<string> explicitExecutablePaths)
        {
            List<string> candidates = new List<string>();
            if (explicitExecutablePaths != null)
            {
                foreach (string explicitPath in explicitExecutablePaths)
                {
                    if (string.IsNullOrWhiteSpace(explicitPath)) continue;
                    string explicitName = Path.GetFileName(explicitPath);
                    for (int e = 0; e < spec.ExecutableNames.Length; e++)
                        if (string.Equals(explicitName, spec.ExecutableNames[e], StringComparison.OrdinalIgnoreCase)) candidates.Add(explicitPath);
                }
            }
            for (int i = 0; i < registryLocations.Count; i++)
            {
                for (int e = 0; e < spec.ExecutableNames.Length; e++)
                {
                    candidates.Add(Path.Combine(registryLocations[i], spec.ExecutableNames[e]));
                    candidates.Add(Path.Combine(registryLocations[i], "Support Files", spec.ExecutableNames[e]));
                }
            }

            // Adobe installations are not always registered consistently. Probe
            // both 64-bit and 32-bit program roots, then search inside Adobe
            // product folders for the exact host executable. This remains
            // bounded to Adobe directories and never scans an entire drive.
            List<string> adobeRoots = new List<string>();
            AddAdobeRoot(adobeRoots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles));
            AddAdobeRoot(adobeRoots, Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86));
            AddAdobeRoot(adobeRoots, Environment.GetEnvironmentVariable("ProgramW6432"));
            AddAdobeRoot(adobeRoots, Environment.GetEnvironmentVariable("ProgramFiles(x86)"));
            AddAdjacentAdobeRoots(adobeRoots);
            AddAdobeRootsOnFixedDrives(adobeRoots);
            for (int r = 0; r < adobeRoots.Count; r++)
            {
                string adobeRoot = adobeRoots[r];
                try
                {
                    for (int e = 0; e < spec.ExecutableNames.Length; e++)
                    {
                        string[] exactMatches = Directory.GetFiles(adobeRoot, spec.ExecutableNames[e], SearchOption.AllDirectories);
                        for (int m = 0; m < exactMatches.Length; m++) candidates.Add(exactMatches[m]);
                    }
                }
                catch (UnauthorizedAccessException) { }
                catch (DirectoryNotFoundException) { }
                catch (IOException) { }
            }

            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HostInstallation bestUnsupported = null;
            for (int i = 0; i < candidates.Count; i++)
            {
                string candidate;
                try { candidate = Path.GetFullPath(candidates[i]); }
                catch { continue; }
                if (!seen.Add(candidate) || !File.Exists(candidate)) continue;

                FileVersionInfo versionInfo;
                try { versionInfo = FileVersionInfo.GetVersionInfo(candidate); }
                catch { continue; }
                int major = versionInfo.ProductMajorPart != 0 ? versionInfo.ProductMajorPart : versionInfo.FileMajorPart;
                int minor = versionInfo.ProductMinorPart != 0 ? versionInfo.ProductMinorPart : versionInfo.FileMinorPart;
                string version = !string.IsNullOrWhiteSpace(versionInfo.ProductVersion) ? versionInfo.ProductVersion : versionInfo.FileVersion;
                bool supported = ProductInfo.IsSupportedHostVersion(spec.Code, major, minor);
                HostInstallation found = new HostInstallation
                {
                    HostCode = spec.Code,
                    DisplayName = spec.DisplayName,
                    ExecutablePath = candidate,
                    Version = version,
                    Found = true,
                    Supported = supported,
                    Status = supported ? "Supported Adobe 2020+" : "Installed, but " + ProductInfo.SupportedHostLabel(spec.Code) + " is required"
                };
                if (supported) return found;
                if (bestUnsupported == null) bestUnsupported = found;
            }

            if (bestUnsupported != null) return bestUnsupported;
            return new HostInstallation
            {
                HostCode = spec.Code,
                DisplayName = spec.DisplayName,
                Found = false,
                Supported = false,
                Status = "Not detected"
            };
        }

        private static List<string> ReadAdobeInstallLocations()
        {
            List<string> result = new List<string>();
            RegistryHive[] hives = new RegistryHive[] { RegistryHive.LocalMachine, RegistryHive.CurrentUser };
            RegistryView[] views = new RegistryView[] { RegistryView.Registry64, RegistryView.Registry32 };
            for (int h = 0; h < hives.Length; h++)
            {
                for (int v = 0; v < views.Length; v++)
                {
                    try
                    {
                        using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hives[h], views[v]))
                        using (RegistryKey uninstall = baseKey.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"))
                        {
                            if (uninstall == null) continue;
                            string[] names = uninstall.GetSubKeyNames();
                            for (int i = 0; i < names.Length; i++)
                            {
                                using (RegistryKey item = uninstall.OpenSubKey(names[i]))
                                {
                                    if (item == null) continue;
                                    string display = Convert.ToString(item.GetValue("DisplayName"));
                                    if (!LooksLikeAdobeHost(display)) continue;
                                    AddIfDirectory(result, Convert.ToString(item.GetValue("InstallLocation")));
                                    string icon = Convert.ToString(item.GetValue("DisplayIcon"));
                                    if (!string.IsNullOrWhiteSpace(icon))
                                    {
                                        icon = icon.Trim().Trim('"');
                                        int comma = icon.LastIndexOf(',');
                                        if (comma > 2) icon = icon.Substring(0, comma).Trim().Trim('"');
                                        if (File.Exists(icon)) AddIfDirectory(result, Path.GetDirectoryName(icon));
                                    }
                                }
                            }
                        }
                    }
                    catch (Exception) { }
                }
            }
            return result;
        }

        private static bool LooksLikeAdobeHost(string displayName)
        {
            if (string.IsNullOrWhiteSpace(displayName)) return false;
            for (int i = 0; i < Specs.Length; i++)
            {
                for (int n = 0; n < Specs[i].RegistryNameFragments.Length; n++)
                {
                    if (displayName.IndexOf(Specs[i].RegistryNameFragments[n], StringComparison.OrdinalIgnoreCase) >= 0) return true;
                }
            }
            return false;
        }

        private static void AddIfDirectory(List<string> list, string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
            for (int i = 0; i < list.Count; i++) if (string.Equals(list[i], path, StringComparison.OrdinalIgnoreCase)) return;
            list.Add(path);
        }

        private static void AddAdobeRoot(List<string> list, string programFiles)
        {
            if (string.IsNullOrWhiteSpace(programFiles)) return;
            string root = Path.Combine(programFiles, "Adobe");
            if (!Directory.Exists(root)) return;
            for (int i = 0; i < list.Count; i++) if (string.Equals(list[i], root, StringComparison.OrdinalIgnoreCase)) return;
            list.Add(root);
        }

        private static void AddAdobeRootsOnFixedDrives(List<string> list)
        {
            try
            {
                DriveInfo[] drives = DriveInfo.GetDrives();
                for (int i = 0; i < drives.Length; i++)
                {
                    DriveInfo drive = drives[i];
                    if (drive.DriveType != DriveType.Fixed) continue;
                    string root = drive.RootDirectory.FullName;
                    AddExistingRoot(list, Path.Combine(root, "Adobe"));
                    AddExistingRoot(list, Path.Combine(root, "Program Files", "Adobe"));
                    AddExistingRoot(list, Path.Combine(root, "Program Files (x86)", "Adobe"));
                }
            }
            catch (Exception) { }
        }

        private static void AddAdjacentAdobeRoots(List<string> list)
        {
            string current = AppDomain.CurrentDomain.BaseDirectory;
            for (int depth = 0; depth < 6 && !string.IsNullOrWhiteSpace(current); depth++)
            {
                AddExistingRoot(list, Path.Combine(current, "Adobe"));
                string parent = Path.GetDirectoryName(current.TrimEnd(Path.DirectorySeparatorChar));
                if (string.Equals(parent, current, StringComparison.OrdinalIgnoreCase)) break;
                current = parent;
            }
        }

        private static void AddExistingRoot(List<string> list, string root)
        {
            if (!Directory.Exists(root)) return;
            for (int i = 0; i < list.Count; i++) if (string.Equals(list[i], root, StringComparison.OrdinalIgnoreCase)) return;
            list.Add(root);
        }
    }

    internal static class InstalledRuntimeDetector
    {
        public static string Find(AppPaths paths)
        {
            string managed = FindWhisperExecutable(paths.RuntimeRoot, true);
            if (managed != null) return managed;

            // PATH is advisory only. The installer does not execute arbitrary
            // PATH entries in order to decide whether it may skip its managed
            // CPU fallback. The extension verifies a selected external runtime
            // when the user starts a transcription job.
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            string[] directories = pathValue.Split(new char[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < directories.Length; i++)
            {
                string candidate = FindWhisperExecutable(directories[i].Trim().Trim('"'), false);
                if (candidate != null) return candidate;
            }
            return null;
        }

        public static string FindVulkan(AppPaths paths)
        {
            string managed = FindVulkanExecutable(paths.RuntimeRoot, true);
            if (managed != null) return managed;
            string pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
            string[] directories = pathValue.Split(new char[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries);
            for (int i = 0; i < directories.Length; i++)
            {
                string candidate = FindVulkanExecutable(directories[i].Trim().Trim('"'), false);
                if (candidate != null) return candidate;
            }
            return null;
        }

        private static string FindWhisperExecutable(string directory, bool recursive)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return null;
            string[] names = new string[] { "whisper-cli.exe", "whisper.exe" };
            try
            {
                for (int i = 0; i < names.Length; i++)
                {
                    string direct = Path.Combine(directory, names[i]);
                    if (WhisperRuntimeIdentity.IsLikelyWhisperCli(direct) && !WhisperRuntimeIdentity.IsVulkanWhisperCli(direct)) return direct;
                    if (!recursive) continue;
                    string[] nested = Directory.GetFiles(directory, names[i], SearchOption.AllDirectories);
                    for (int n = 0; n < nested.Length; n++)
                        if (WhisperRuntimeIdentity.IsLikelyWhisperCli(nested[n]) && !WhisperRuntimeIdentity.IsVulkanWhisperCli(nested[n])) return nested[n];
                }
            }
            catch (Exception) { }
            return null;
        }

        private static string FindVulkanExecutable(string directory, bool recursive)
        {
            if (string.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) return null;
            try
            {
                string[] names = new string[] { "whisper-cli.exe", "whisper.exe" };
                for (int i = 0; i < names.Length; i++)
                {
                    string[] candidates = recursive ? Directory.GetFiles(directory, names[i], SearchOption.AllDirectories) : new string[] { Path.Combine(directory, names[i]) };
                    for (int j = 0; j < candidates.Length; j++)
                    {
                        string parent = Path.GetDirectoryName(candidates[j]);
                        if (WhisperRuntimeIdentity.IsLikelyWhisperCli(candidates[j]) && File.Exists(Path.Combine(parent, "ggml-vulkan.dll"))) return candidates[j];
                    }
                }
            }
            catch (Exception) { }
            return null;
        }
    }

    internal static class WhisperRuntimeIdentity
    {
        public static bool IsLikelyWhisperCli(string executablePath)
        {
            if (string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath)) return false;
            string fileName = Path.GetFileName(executablePath);
            if (!string.Equals(fileName, "whisper-cli.exe", StringComparison.OrdinalIgnoreCase)
                && !string.Equals(fileName, "whisper.exe", StringComparison.OrdinalIgnoreCase)) return false;
            string directory = Path.GetDirectoryName(executablePath);
            return File.Exists(Path.Combine(directory, "whisper.dll"))
                && File.Exists(Path.Combine(directory, "ggml.dll"));
        }

        public static bool IsVulkanWhisperCli(string executablePath)
        {
            if (!IsLikelyWhisperCli(executablePath)) return false;
            string directory = Path.GetDirectoryName(executablePath);
            return File.Exists(Path.Combine(directory, "ggml-vulkan.dll"));
        }
    }

    internal static class WhisperRuntimeSelfTest
    {
        // This process is invoked only after the archive has passed the pinned
        // size/SHA-256 check and has been extracted into our private staging dir.
        public static bool RunVerifiedArchiveSelfTest(string executablePath)
        {
            if (!WhisperRuntimeIdentity.IsLikelyWhisperCli(executablePath)) return false;
            try
            {
                ProcessStartInfo start = new ProcessStartInfo(executablePath, "--version");
                start.WorkingDirectory = Path.GetDirectoryName(executablePath);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                using (Process process = Process.Start(start))
                {
                    if (process == null) return false;
                    if (!process.WaitForExit(5000))
                    {
                        try { process.Kill(); }
                        catch { }
                        return false;
                    }
                    return process.ExitCode == 0;
                }
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
