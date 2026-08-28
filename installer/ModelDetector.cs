using System;
using System.Collections.Generic;
using System.IO;

namespace LocalWhisperSubtitles.Setup
{
    internal static class ModelDetector
    {
        private static readonly HashSet<string> IgnoredDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "$recycle.bin",
            "system volume information",
            "node_modules",
            ".git",
            "windows"
        };

        public static ModelScanResult ScanQuick()
        {
            return Scan("quick", DefaultRoots(), 5, 20000, 5000);
        }

        public static ModelScanResult ScanSpecified(string modelPath)
        {
            return Scan("specified", new string[] { modelPath }, 8, 20000, 5000);
        }

        public static ModelScanResult Scan(string mode, IEnumerable<string> roots, int maxDepth, int maxEntries, int maxDurationMs)
        {
            ModelScanResult output = new ModelScanResult
            {
                Mode = mode ?? "quick",
                Status = "scanning",
                Models = new List<ModelCandidate>(),
                Warnings = new List<string>()
            };
            Queue<ScanNode> queue = new Queue<ScanNode>();
            HashSet<string> visitedDirectories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            HashSet<string> modelPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(100, maxDurationMs));

            foreach (string root in roots ?? new string[0])
            {
                if (string.IsNullOrWhiteSpace(root)) continue;
                try { queue.Enqueue(new ScanNode(Path.GetFullPath(root), 0, true)); }
                catch (Exception exception) { output.Warnings.Add("Invalid scan root: " + exception.Message); }
            }

            while (queue.Count > 0)
            {
                if (output.Entries >= maxEntries || DateTime.UtcNow >= deadline)
                {
                    output.Status = "partial";
                    break;
                }

                ScanNode node = queue.Dequeue();
                FileAttributes attributes;
                try { attributes = File.GetAttributes(node.Path); }
                catch (Exception exception)
                {
                    if (node.IsRoot) output.Warnings.Add("Cannot access " + node.Path + ": " + exception.Message);
                    continue;
                }
                if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
                output.Entries++;

                if ((attributes & FileAttributes.Directory) == 0)
                {
                    ModelCandidate candidate = InspectFile(node.Path);
                    if (candidate != null && modelPaths.Add(candidate.Path)) output.Models.Add(candidate);
                    continue;
                }
                if (node.Depth > maxDepth) continue;

                ModelCandidate directoryCandidate = InspectDirectory(node.Path);
                if (directoryCandidate != null && modelPaths.Add(directoryCandidate.Path)) output.Models.Add(directoryCandidate);

                string realDirectory;
                try { realDirectory = Path.GetFullPath(node.Path); }
                catch { continue; }
                if (!visitedDirectories.Add(realDirectory)) continue;

                string[] children;
                try { children = Directory.GetFileSystemEntries(realDirectory); }
                catch (Exception exception)
                {
                    output.Warnings.Add("Cannot enumerate " + realDirectory + ": " + exception.Message);
                    continue;
                }
                for (int i = 0; i < children.Length; i++)
                {
                    if (DateTime.UtcNow >= deadline || output.Entries >= maxEntries) break;
                    string name = Path.GetFileName(children[i]);
                    try
                    {
                        FileAttributes childAttributes = File.GetAttributes(children[i]);
                        if ((childAttributes & FileAttributes.ReparsePoint) != 0) continue;
                        if ((childAttributes & FileAttributes.Directory) != 0 && IgnoredDirectories.Contains(name)) continue;
                        queue.Enqueue(new ScanNode(children[i], node.Depth + 1, false));
                    }
                    catch (Exception exception)
                    {
                        output.Warnings.Add("Cannot inspect " + children[i] + ": " + exception.Message);
                    }
                }
            }

            if (output.Status == "scanning") output.Status = "completed";
            for (int i = 0; i < output.Models.Count; i++)
                if (output.Models[i].CompatibleWithWhisperCpp) output.CompatibleCount++;
            return output;
        }

        public static IEnumerable<string> DefaultRoots()
        {
            List<string> roots = new List<string>();
            string home = Environment.GetEnvironmentVariable("USERPROFILE") ?? string.Empty;
            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            AddRoot(roots, Environment.GetEnvironmentVariable("WHISPER_MODEL_DIR"));
            AddRoot(roots, Environment.GetEnvironmentVariable("HF_HOME"));
            AddRoot(roots, Path.Combine(home, ".cache", "whisper"));
            AddRoot(roots, Path.Combine(home, ".cache", "huggingface", "hub"));
            AddRoot(roots, Path.Combine(local, "whisper"));
            AddRoot(roots, Path.Combine(local, "LocalWhisperSubtitles", "models"));
            return roots;
        }

        private static ModelCandidate InspectFile(string filePath)
        {
            string extension = Path.GetExtension(filePath).ToLowerInvariant();
            if (extension != ".bin" && extension != ".gguf" && extension != ".pt") return null;

            FileInfo info;
            try
            {
                info = new FileInfo(filePath);
                if (!info.Exists || info.Length <= 0) return null;
            }
            catch { return null; }

            string format;
            bool compatible;
            string reason;
            if (extension == ".pt")
            {
                format = "openai-pt";
                compatible = false;
                reason = "需要 Python/OpenAI Whisper 运行时；安装器不会加载 .pt。";
            }
            else
            {
                string magic = ReadMagic(filePath);
                if (magic == "GGUF")
                {
                    format = "gguf";
                    compatible = true;
                    reason = "GGUF 文件头已识别，可由 whisper.cpp 运行时匹配。";
                }
                else if (magic == "lmgg" || magic == "ggml" || magic == "fmgg" || magic == "tjgg")
                {
                    format = "ggml-bin";
                    compatible = true;
                    reason = "GGML 文件头已识别，可由 whisper.cpp 运行时匹配。";
                }
                else
                {
                    format = "unknown";
                    compatible = false;
                    reason = "文件头不是受支持的 GGML/GGUF 格式。";
                }
            }

            return new ModelCandidate
            {
                Path = Path.GetFullPath(filePath),
                DisplayName = Path.GetFileNameWithoutExtension(filePath),
                Format = format,
                SizeBytes = info.Length,
                CompatibleWithWhisperCpp = compatible,
                CompatibilityReason = reason,
                Origin = "scan"
            };
        }

        private static ModelCandidate InspectDirectory(string directoryPath)
        {
            try
            {
                string model = Path.Combine(directoryPath, "model.bin");
                string config = Path.Combine(directoryPath, "config.json");
                string tokenizer = Path.Combine(directoryPath, "tokenizer.json");
                string vocabulary = Path.Combine(directoryPath, "vocabulary.json");
                string safeTensors = Path.Combine(directoryPath, "model.safetensors");
                string preprocessor = Path.Combine(directoryPath, "preprocessor_config.json");
                if (File.Exists(safeTensors) && File.Exists(config) && File.Exists(preprocessor) && File.Exists(tokenizer))
                {
                    string configText = File.ReadAllText(config);
                    if (configText.Replace(" ", string.Empty).Replace("\r", string.Empty).Replace("\n", string.Empty).IndexOf("\"model_type\":\"whisper\"", StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return new ModelCandidate
                        {
                            Path = Path.GetFullPath(directoryPath),
                            DisplayName = Path.GetFileName(directoryPath),
                            Format = "huggingface-whisper",
                            SizeBytes = new FileInfo(safeTensors).Length,
                            CompatibleWithWhisperCpp = false,
                            CompatibilityReason = "Transformers Whisper + PyTorch runtime required.",
                            Origin = "scan"
                        };
                    }
                }
                if (!File.Exists(model) || !File.Exists(config) || (!File.Exists(tokenizer) && !File.Exists(vocabulary))) return null;
                return new ModelCandidate
                {
                    Path = Path.GetFullPath(directoryPath),
                    DisplayName = Path.GetFileName(directoryPath),
                    Format = "ctranslate2",
                    SizeBytes = new FileInfo(model).Length,
                    CompatibleWithWhisperCpp = false,
                    CompatibilityReason = "需要 faster-whisper/CTranslate2 运行时。",
                    Origin = "scan"
                };
            }
            catch { return null; }
        }

        private static string ReadMagic(string filePath)
        {
            try
            {
                byte[] bytes = new byte[4];
                using (FileStream stream = new FileStream(filePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    int read = stream.Read(bytes, 0, bytes.Length);
                    if (read < bytes.Length) return string.Empty;
                }
                return System.Text.Encoding.ASCII.GetString(bytes);
            }
            catch { return string.Empty; }
        }

        private static void AddRoot(List<string> roots, string root)
        {
            if (string.IsNullOrWhiteSpace(root)) return;
            string full;
            try { full = Path.GetFullPath(root); }
            catch { return; }
            for (int i = 0; i < roots.Count; i++)
                if (string.Equals(roots[i], full, StringComparison.OrdinalIgnoreCase)) return;
            roots.Add(full);
        }

        private sealed class ScanNode
        {
            public readonly string Path;
            public readonly int Depth;
            public readonly bool IsRoot;

            public ScanNode(string path, int depth, bool isRoot)
            {
                Path = path;
                Depth = depth;
                IsRoot = isRoot;
            }
        }
    }
}
