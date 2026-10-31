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
            Run("NSIS temp backend retains adjacent Adobe roots from the distribution directory", TestDistributionAdobeRoot);
            Run("Adobe 2020 host versions use product-specific majors", delegate
            {
                Assert(ProductInfo.IsSupportedHostVersion("AEFT", 17, 0), "AE 2020 must be supported.");
                Assert(!ProductInfo.IsSupportedHostVersion("AEFT", 16, 9), "AE 2019 must not be supported.");
                Assert(ProductInfo.IsSupportedHostVersion("PPRO", 14, 0), "Premiere Pro 2020 must be supported.");
                Assert(!ProductInfo.IsSupportedHostVersion("PPRO", 13, 9), "Premiere Pro 2019 must not be supported.");
            });
            Run("non-standard Conda root supplies a Python candidate", TestNonStandardCondaRoot);
            Run("portable and venv interpreters are discovered below a selected folder", TestPortablePythonRoots);
            Run("saved resource paths are restored without reading API credentials", TestSavedResourceHints);
            Run("Python CPU backends run their matching models without CUDA", TestPythonCpuCompatibility);
            Run("backend dependencies cannot be combined across interpreters", TestSeparatePythonDependencies);
            Run("NSIS Unicode options preserve paths and custom installs cannot download", TestNsisOptions);
            Run("Hugging Face Whisper directory is recognized", TestHuggingFaceWhisperDirectory);
            Run("installer state contract preserves selected model path", delegate
            {
                InstallOptions options = new InstallOptions { ModelPath = @"X:\models\whisper" };
                InstallState state = new InstallState { modelPath = options.ModelPath };
                Assert(state.modelPath == options.ModelPath, "Selected model path was not preserved by installer state.");
                InstallState quickState = new InstallState { modelDestinationFolder = @"X:\models" };
                Assert(quickState.modelDestinationFolder == @"X:\models", "Quick-install model destination was not preserved by installer state.");
                quickState.installWhisperCppVadModel = true;
                Assert(quickState.installWhisperCppVadModel, "Quick-install VAD ownership was not preserved by installer state.");
                quickState.whisperCppVadModelSha256 = "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987";
                Assert(quickState.whisperCppVadModelSha256.Length == 64, "Quick-install VAD hash was not preserved by installer state.");
            });
            Run("recommended model metadata has pinned download integrity", delegate
            {
                ResourcePackage model = ResourceCatalog.Load(args[0]).FindRecommendedModel();
                Assert(model != null && model.downloadUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase), "Recommended model HTTPS URL is missing.");
                Assert(model.size > 0 && !string.IsNullOrWhiteSpace(model.sha256) && model.sha256.Length == 64, "Recommended model integrity metadata is missing.");
            });
            Run("bundled whisper.cpp VAD model has pinned integrity", delegate
            {
                ResourceCatalog catalog = ResourceCatalog.Load(args[0]);
                ResourcePackage vadModel = catalog.FindRecommendedVadModel();
                Assert(vadModel != null, "Recommended whisper.cpp VAD model metadata is missing.");
                Assert(vadModel.bundled, "Quick STT needs the whisper.cpp VAD model in the external resource bundle.");
                Assert(!vadModel.required, "VAD must remain optional for custom and AE effect-copy-only installs.");
                Assert(string.Equals(Path.GetFileName(vadModel.localPath), "ggml-silero-v6.2.0.bin", StringComparison.OrdinalIgnoreCase),
                    "The bundled VAD model must preserve its official upstream file name.");
                ResourceValidation validation = catalog.Validate(vadModel);
                Assert(validation.IsValid, validation.Error);
                Assert(vadModel.size == 885098, "Unexpected Silero VAD model size.");
                Assert(string.Equals(vadModel.sha256, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987", StringComparison.OrdinalIgnoreCase),
                    "Unexpected Silero VAD model SHA-256.");
            });
            Run("VAD model ids share the global resource namespace", TestVadModelIdsShareGlobalNamespace);
            Console.WriteLine("PASS: {0} installer tests", _passed);
        }

        private static void TestVadModelIdsShareGlobalNamespace()
        {
            string root = NewTempRoot();
            try
            {
                File.WriteAllText(Path.Combine(root, "manifest.json"),
                    "{\"schemaVersion\":\"1.0\",\"integrityAlgorithm\":\"SHA-256\","
                    + "\"runtimes\":[{\"id\":\"duplicate\"}],\"models\":[],"
                    + "\"vadModels\":[{\"id\":\"duplicate\"}],\"licenses\":[]}");
                bool rejected = false;
                try { ResourceCatalog.Load(root); }
                catch (InvalidDataException) { rejected = true; }
                Assert(rejected, "A VAD model id duplicated from another resource category was accepted.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
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

        private static void TestDistributionAdobeRoot()
        {
            string root = NewTempRoot(), previous = Environment.CurrentDirectory;
            try
            {
                string distribution = Path.Combine(root, "release", "installer");
                string adobe = Path.Combine(root, "Adobe");
                Directory.CreateDirectory(distribution);
                Directory.CreateDirectory(adobe);
                Environment.CurrentDirectory = distribution;
                System.Collections.Generic.List<string> roots = new System.Collections.Generic.List<string>();
                typeof(HostDetector).GetMethod("AddAdjacentAdobeRoots", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic).Invoke(null, new object[] { roots });
                Assert(roots.Contains(adobe), "Extracting the NSIS backend into TEMP lost the original adjacent Adobe root.");
            }
            finally { Environment.CurrentDirectory = previous; SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestPortablePythonRoots()
        {
            string root = NewTempRoot();
            try
            {
                string portable = Path.Combine(root, "moved-tool", "bundle", "runtime", "python.exe");
                string venv = Path.Combine(root, "project", ".venv", "Scripts", "python.exe");
                Directory.CreateDirectory(Path.GetDirectoryName(portable));
                Directory.CreateDirectory(Path.GetDirectoryName(venv));
                File.WriteAllText(portable, "placeholder");
                File.WriteAllText(venv, "placeholder");
                System.Collections.Generic.List<string> candidates = GpuRuntimeDetector.FindPythonCandidates(new string[] { root }, false);
                Assert(candidates.Contains(portable), "The moved portable Python environment was missed.");
                Assert(candidates.Contains(venv), "The venv Scripts interpreter was missed.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestSavedResourceHints()
        {
            string root = NewTempRoot();
            try
            {
                string model = Path.Combine(root, "Whisper 模型");
                Directory.CreateDirectory(model);
                string escaped = model.Replace("\\", "\\\\");
                File.WriteAllText(Path.Combine(root, "setting.txt"), "{\"scanPath\":\"" + escaped + "\",\"selectedModelId\":\"one\",\"models\":[{\"id\":\"one\",\"path\":\"" + escaped + "\"}],\"translation\":{\"apiKey\":\"secret-never-read\"}}");
                LocalResourceHints hints = LocalResourceHints.Load(root);
                Assert(hints.ModelRoots.Contains(model), "Saved panel model path was omitted.");
                Assert(hints.PreferredModelPath == model, "Panel selection was not restored.");
                Assert(!hints.ModelRoots.Contains("secret-never-read"), "Credentials leaked into resource paths.");
            }
            finally { SafeFileSystem.DeleteDirectory(root); }
        }

        private static void TestPythonCpuCompatibility()
        {
            PythonRuntimeInfo environment = new PythonRuntimeInfo { PythonPath = "cpu-python.exe", Torch = true, TransformersWhisper = true, OpenAiWhisper = true, FasterWhisper = true, CTranslate2Cpu = true };
            InspectionResult result = new InspectionResult { GpuRuntime = new GpuRuntimeStatus { Environments = new System.Collections.Generic.List<PythonRuntimeInfo> { environment }, PythonWhisperCpu = true } };
            foreach (string format in new string[] { "openai-pt", "huggingface-whisper", "ctranslate2" })
                Assert(RuntimeCompatibility.CanRun(new ModelCandidate { Format = format }, result), "CPU environment was rejected for " + format);
            Assert(!environment.Supports("huggingface-whisper", true), "CPU environment was incorrectly marked GPU-ready.");
        }

        private static void TestSeparatePythonDependencies()
        {
            GpuRuntimeStatus status = new GpuRuntimeStatus { Environments = new System.Collections.Generic.List<PythonRuntimeInfo> {
                new PythonRuntimeInfo { PythonPath = "torch-only.exe", Torch = true, TorchCuda = true },
                new PythonRuntimeInfo { PythonPath = "transformers-only.exe", TransformersWhisper = true }
            }};
            Assert(status.PythonForModel("huggingface-whisper") == null, "Dependencies from separate interpreters produced a false usable result.");
        }

        private static void TestNsisOptions()
        {
            string root = NewTempRoot();
            try
            {
                string file = Path.Combine(root, "options.ini");
                string model = Path.Combine(root, "模型 😀", "whisper");
                File.WriteAllText(file, "[options]\r\nquick=0\r\nae=1\r\npr=1\r\nstt=1\r\ngpu=1\r\nmodelPath=" + model + "\r\n", System.Text.Encoding.Unicode);
                InstallOptions custom = NsisBridge.ReadOptions(file);
                Assert(custom.ModelPath == model, "Unicode model path changed in the NSIS/backend handoff.");
                Assert(custom.InstallEffectCopy && custom.InstallAfterEffects, "AE effect-copy must be mandatory.");
                Assert(!custom.DownloadRecommendedModel && !custom.InstallCpuRuntime && !custom.InstallVulkanRuntime, "Custom install requested downloads.");
                File.WriteAllText(file, "[options]\r\nquick=1\r\nae=0\r\npr=1\r\nstt=0\r\ngpu=1\r\n", System.Text.Encoding.Unicode);
                InstallOptions quick = NsisBridge.ReadOptions(file);
                Assert(quick.DownloadRecommendedModel && quick.InstallCpuRuntime && quick.InstallVulkanRuntime, "Quick PR must require CPU STT and preserve optional Vulkan.");
                Assert(!quick.LicenseAccepted, "Download consent must not default on.");
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
