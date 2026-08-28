using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using Microsoft.Win32;

namespace LocalWhisperSubtitles.Setup
{
    internal static class InstallerTests
    {
        private static int _passed;

        private static void Main(string[] args)
        {
            if (args.Length != 1) throw new ArgumentException("Expected resources root argument.");
            Run("resource manifest and CPU archive verify", delegate
            {
                ResourceCatalog catalog = ResourceCatalog.Load(args[0]);
                ResourceValidation runtime = catalog.Validate(catalog.FindCpuRuntime());
                Assert(runtime.IsValid, runtime.Error);
                Assert(!catalog.FindCpuRuntime().required, "CPU STT must remain optional for AE-only installs.");
                ResourceValidation vulkan = catalog.Validate(catalog.FindVulkanRuntime());
                Assert(vulkan.IsValid, vulkan == null ? "Vulkan runtime metadata is missing." : vulkan.Error);
                Assert(catalog.FindRecommendedModel() != null, "Recommended model metadata is missing.");
                Assert(!catalog.FindRecommendedModel().bundled, "The recommended model must not be bundled.");
            });
            Run("path traversal is rejected", delegate
            {
                bool rejected = false;
                try { PathSafety.ResolveChildPath(args[0], @"..\outside.bin"); }
                catch (InvalidDataException) { rejected = true; }
                Assert(rejected, "Traversal path was accepted.");
            });
            Run("zip traversal is rejected", TestZipTraversal);
            Run("bundled whisper runtime starts", delegate { TestRuntimeStarts(args[0]); });
            Run("runtime identity rejects arbitrary main.exe", TestRuntimeIdentityRejectsArbitraryMain);
            Run("runtime identity separates Vulkan whisper-cli from CPU whisper-cli", TestRuntimeIdentitySeparatesVulkan);
            Run("directory replacement rolls back", TestTransactionRollback);
            Run("directory replacement commits", TestTransactionCommit);
            Run("registry value rolls back", TestRegistryRollback);
            Run("host detector returns AE and PR states", delegate
            {
                Assert(HostDetector.DetectSupportedHosts().Count == 2, "Host detector did not return two host states.");
            });
            Run("non-standard Conda root supplies a Python candidate", TestNonStandardCondaRoot);
            Run("Hugging Face Whisper directory is recognized", TestHuggingFaceWhisperDirectory);
            Run("installer state contract preserves selected model path", delegate
            {
                InstallOptions options = new InstallOptions { ModelPath = @"X:\models\whisper" };
                InstallState state = new InstallState { modelPath = options.ModelPath };
                Assert(state.modelPath == options.ModelPath, "Selected model path was not preserved by installer state.");
                InstallState quickState = new InstallState { modelDestinationFolder = @"X:\models" };
                Assert(quickState.modelDestinationFolder == @"X:\models", "Quick-install model destination was not preserved by installer state.");
            });
            Run("recommended model metadata has pinned download integrity", delegate
            {
                ResourcePackage model = ResourceCatalog.Load(args[0]).FindRecommendedModel();
                Assert(model != null && model.downloadUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase), "Recommended model HTTPS URL is missing.");
                Assert(model.size > 0 && !string.IsNullOrWhiteSpace(model.sha256) && model.sha256.Length == 64, "Recommended model integrity metadata is missing.");
            });
            Console.WriteLine("PASS: {0} installer tests", _passed);
        }

        private static void TestZipTraversal()
        {
            string root = NewTempRoot();
            try
            {
                string zipPath = Path.Combine(root, "bad.zip");
                using (FileStream stream = File.Create(zipPath))
                using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Create))
                {
                    ZipArchiveEntry entry = archive.CreateEntry("../escaped.txt");
                    using (StreamWriter writer = new StreamWriter(entry.Open())) writer.Write("bad");
                }
                bool rejected = false;
                try { SafeZipExtractor.Extract(zipPath, Path.Combine(root, "out")); }
                catch (InvalidDataException) { rejected = true; }
                Assert(rejected, "Malicious zip path was accepted.");
                Assert(!File.Exists(Path.Combine(root, "escaped.txt")), "Zip wrote outside destination.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestTransactionRollback()
        {
            string root = NewTempRoot();
            try
            {
                string target = Path.Combine(root, "target");
                Directory.CreateDirectory(target);
                File.WriteAllText(Path.Combine(target, "value.txt"), "old");
                using (InstallTransaction transaction = new InstallTransaction())
                {
                    string incoming = transaction.CreateIncomingDirectory(target);
                    File.WriteAllText(Path.Combine(incoming, "value.txt"), "new");
                    transaction.ReplaceDirectory(incoming, target);
                    transaction.Rollback();
                }
                Assert(File.ReadAllText(Path.Combine(target, "value.txt")) == "old", "Rollback did not restore original directory.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestRuntimeStarts(string resourcesRoot)
        {
            ResourceCatalog catalog = ResourceCatalog.Load(resourcesRoot);
            ResourceValidation validation = catalog.Validate(catalog.FindCpuRuntime());
            Assert(validation.IsValid, validation.Error);
            string root = NewTempRoot();
            try
            {
                SafeZipExtractor.Extract(validation.FullPath, root);
                string[] executables = Directory.GetFiles(root, "whisper-cli.exe", SearchOption.AllDirectories);
                Assert(executables.Length == 1, "Runtime archive does not contain exactly one whisper-cli.exe.");
                ProcessStartInfo start = new ProcessStartInfo(executables[0], "--help");
                start.WorkingDirectory = Path.GetDirectoryName(executables[0]);
                start.UseShellExecute = false;
                start.CreateNoWindow = true;
                using (Process process = Process.Start(start))
                {
                    Assert(process != null, "whisper-cli did not start.");
                    if (!process.WaitForExit(15000))
                    {
                        process.Kill();
                        throw new TimeoutException("whisper-cli --help did not finish within 15 seconds.");
                    }
                    Assert(process.ExitCode == 0, "whisper-cli probe failed with exit code " + process.ExitCode + ".");
                }
                Assert(WhisperRuntimeIdentity.IsLikelyWhisperCli(executables[0]), "Runtime identity rejected bundled whisper-cli.");
                Assert(WhisperRuntimeSelfTest.RunVerifiedArchiveSelfTest(executables[0]), "Verified runtime self-test rejected bundled whisper-cli.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestRuntimeIdentityRejectsArbitraryMain()
        {
            string root = NewTempRoot();
            try
            {
                string fakeMain = Path.Combine(root, "main.exe");
                File.WriteAllText(fakeMain, "not a runtime");
                File.WriteAllText(Path.Combine(root, "whisper.dll"), "placeholder");
                File.WriteAllText(Path.Combine(root, "ggml.dll"), "placeholder");
                Assert(!WhisperRuntimeIdentity.IsLikelyWhisperCli(fakeMain), "An arbitrary main.exe was accepted as a runtime.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestRuntimeIdentitySeparatesVulkan()
        {
            string root = NewTempRoot();
            try
            {
                string executable = Path.Combine(root, "whisper-cli.exe");
                File.WriteAllText(executable, "placeholder");
                File.WriteAllText(Path.Combine(root, "whisper.dll"), "placeholder");
                File.WriteAllText(Path.Combine(root, "ggml.dll"), "placeholder");
                Assert(WhisperRuntimeIdentity.IsLikelyWhisperCli(executable), "Whisper runtime identity rejected the fixture.");
                Assert(!WhisperRuntimeIdentity.IsVulkanWhisperCli(executable), "CPU fixture was identified as Vulkan.");
                File.WriteAllText(Path.Combine(root, "ggml-vulkan.dll"), "placeholder");
                Assert(WhisperRuntimeIdentity.IsVulkanWhisperCli(executable), "Vulkan runtime identity was not detected.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestTransactionCommit()
        {
            string root = NewTempRoot();
            try
            {
                string target = Path.Combine(root, "target");
                Directory.CreateDirectory(target);
                File.WriteAllText(Path.Combine(target, "value.txt"), "old");
                using (InstallTransaction transaction = new InstallTransaction())
                {
                    string incoming = transaction.CreateIncomingDirectory(target);
                    File.WriteAllText(Path.Combine(incoming, "value.txt"), "new");
                    transaction.ReplaceDirectory(incoming, target);
                    transaction.Commit();
                }
                Assert(File.ReadAllText(Path.Combine(target, "value.txt")) == "new", "Commit did not retain replacement directory.");
                Assert(Directory.GetDirectories(root, "*.backup-*", SearchOption.TopDirectoryOnly).Length == 0, "Commit left a backup directory.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestRegistryRollback()
        {
            string keyPath = @"Software\LocalWhisperSubtitles.Tests\" + Guid.NewGuid().ToString("N");
            try
            {
                using (InstallTransaction transaction = new InstallTransaction())
                {
                    transaction.SetRegistryValue(Registry.CurrentUser, keyPath, "Value", "temporary", RegistryValueKind.String);
                    using (RegistryKey key = Registry.CurrentUser.OpenSubKey(keyPath))
                    {
                        Assert(key != null && Convert.ToString(key.GetValue("Value")) == "temporary", "Registry value was not written.");
                    }
                    transaction.Rollback();
                }
                Assert(Registry.CurrentUser.OpenSubKey(keyPath) == null, "Rollback left the temporary registry key.");
            }
            finally
            {
                try { Registry.CurrentUser.DeleteSubKeyTree(keyPath, false); }
                catch (ArgumentException) { }
            }
        }

        private static void TestNonStandardCondaRoot()
        {
            string root = NewTempRoot();
            try
            {
                string condaRoot = Path.Combine(root, "yun", "Miniconda");
                Directory.CreateDirectory(condaRoot);
                string python = Path.Combine(condaRoot, "python.exe");
                File.WriteAllText(python, "placeholder");
                System.Collections.Generic.List<string> candidates = GpuRuntimeDetector.FindPythonCandidates(
                    new string[] { condaRoot }, false);
                Assert(candidates.Count == 1, "A non-standard Conda Python executable was not found.");
                Assert(string.Equals(candidates[0], Path.GetFullPath(python), StringComparison.OrdinalIgnoreCase),
                    "The discovered Python path was incorrect.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestHuggingFaceWhisperDirectory()
        {
            string root = NewTempRoot();
            try
            {
                File.WriteAllText(Path.Combine(root, "config.json"), "{\"model_type\":\"whisper\"}");
                File.WriteAllText(Path.Combine(root, "preprocessor_config.json"), "{}");
                File.WriteAllText(Path.Combine(root, "tokenizer.json"), "{}");
                File.WriteAllBytes(Path.Combine(root, "model.safetensors"), new byte[] { 1 });
                ModelScanResult result;
                try { result = ModelDetector.ScanSpecified(root); }
                catch (Exception exception) { throw new InvalidOperationException("HF scan failed: " + exception.Message); }
                Assert(result.Models.Count == 1, "Hugging Face Whisper directory was not discovered.");
                Assert(result.Models[0].Format == "huggingface-whisper", "Hugging Face model format was not normalized.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static string NewTempRoot()
        {
            string path = Path.Combine(Path.GetTempPath(), "LocalWhisperSubtitles.Tests", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(path);
            return path;
        }

        private static void Run(string name, Action test)
        {
            test();
            _passed++;
            Console.WriteLine("PASS: " + name);
        }

        private static void Assert(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }
    }
}
