using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;

namespace LocalWhisperSubtitles.Setup
{
    // Only whitelisted resource paths are read. API credentials never enter detection reports.
    internal sealed class LocalResourceHints
    {
        public readonly List<string> ModelRoots = new List<string>();
        public readonly List<string> PythonRoots = new List<string>();
        public readonly List<string> ToolRoots = new List<string>();
        public string PreferredModelPath;

        public static LocalResourceHints ForCurrentUser()
        {
            return Load(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LocalWhisperSubtitles"));
        }

        internal static LocalResourceHints Load(string installRoot)
        {
            LocalResourceHints hints = new LocalResourceHints();
            // The panel's latest selection takes precedence over older installer state.
            foreach (string name in new string[] { "setting.txt", "install-state.json" })
            {
                try
                {
                    string file = Path.Combine(installRoot, name);
                    if (!File.Exists(file) || new FileInfo(file).Length > 8 * 1024 * 1024) continue;
                    JavaScriptSerializer serializer = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };
                    Dictionary<string, object> values = serializer.DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object>;
                    if (values == null) continue;
                    string model = Text(values, "modelPath");
                    Add(hints.ModelRoots, model);
                    Add(hints.ModelRoots, Text(values, "scanPath"));
                    Add(hints.ModelRoots, Text(values, "modelDestinationFolder"));
                    Add(hints.PythonRoots, Text(values, "pythonExecutablePath"));
                    Add(hints.ToolRoots, Text(values, "runtimePath"));
                    Add(hints.ToolRoots, Text(values, "vulkanRuntimePath"));
                    Add(hints.ToolRoots, Text(values, "ffmpegPath"));
                    object raw;
                    if (values.TryGetValue("models", out raw) && raw is IEnumerable)
                    {
                        foreach (object item in (IEnumerable)raw)
                        {
                            Dictionary<string, object> candidate = item as Dictionary<string, object>;
                            if (candidate == null) continue;
                            string path = Text(candidate, "path");
                            Add(hints.ModelRoots, path);
                            if (string.Equals(Text(candidate, "id"), Text(values, "selectedModelId"), StringComparison.Ordinal))
                                hints.PreferredModelPath = Existing(path);
                        }
                    }
                    if (hints.PreferredModelPath == null) hints.PreferredModelPath = Existing(model);
                }
                catch { /* A stale/malformed settings file must not prevent installation. */ }
            }
            Add(hints.ToolRoots, Path.Combine(installRoot, "runtime"));
            return hints;
        }

        public List<string> NearbyRoots()
        {
            List<string> roots = new List<string>();
            foreach (string hint in PythonRoots) AddParents(roots, hint, 3);
            foreach (string hint in ModelRoots) AddParents(roots, hint, 7);
            foreach (string hint in ToolRoots) AddParents(roots, hint, 2);
            return roots;
        }

        private static void AddParents(List<string> roots, string hint, int count)
        {
            try
            {
                string current = File.Exists(hint) || Path.HasExtension(hint) ? Path.GetDirectoryName(hint) : hint;
                for (int i = 0; i < count && !string.IsNullOrEmpty(current); i++)
                {
                    string parent = Path.GetDirectoryName(current.TrimEnd(Path.DirectorySeparatorChar));
                    // Never silently turn a nearby search into a whole-drive scan.
                    if (string.IsNullOrEmpty(parent) || string.Equals(current, Path.GetPathRoot(current), StringComparison.OrdinalIgnoreCase)) break;
                    Add(roots, current);
                    current = parent;
                }
            }
            catch { }
        }

        internal static void Add(List<string> paths, string value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            try
            {
                string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim().Trim('"')));
                if (!paths.Exists(delegate(string item) { return string.Equals(item, full, StringComparison.OrdinalIgnoreCase); })) paths.Add(full);
            }
            catch { }
        }

        private static string Text(Dictionary<string, object> data, string key)
        {
            object value;
            return data.TryGetValue(key, out value) && value is string ? (string)value : null;
        }
        private static string Existing(string value) { return !string.IsNullOrWhiteSpace(value) && (File.Exists(value) || Directory.Exists(value)) ? Path.GetFullPath(value) : null; }
    }

    internal static class NearbyExecutableSearch
    {
        private static readonly HashSet<string> Skip = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "Lib", "site-packages", "node_modules", ".git", "__pycache__", "models", "model", "hf_cache", "cache", ".cache", "Windows", "$RECYCLE.BIN", "System Volume Information" };

        public static List<string> Find(IEnumerable<string> roots, string[] names, int maxDepth, int budgetMs)
        {
            List<string> found = new List<string>();
            HashSet<string> visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            Queue<KeyValuePair<string, int>> pending = new Queue<KeyValuePair<string, int>>();
            foreach (string root in roots ?? new string[0])
            {
                if (string.IsNullOrWhiteSpace(root)) continue;
                try
                {
                    string path = Path.GetFullPath(root);
                    if (File.Exists(path))
                    {
                        foreach (string name in names) if (string.Equals(Path.GetFileName(path), name, StringComparison.OrdinalIgnoreCase)) LocalResourceHints.Add(found, path);
                    }
                    else if (Directory.Exists(path)) pending.Enqueue(new KeyValuePair<string, int>(path, 0));
                }
                catch { }
            }
            DateTime until = DateTime.UtcNow.AddMilliseconds(budgetMs);
            while (pending.Count > 0 && visited.Count < 8000 && DateTime.UtcNow < until)
            {
                KeyValuePair<string, int> entry = pending.Dequeue();
                if (!visited.Add(entry.Key)) continue;
                try
                {
                    if ((File.GetAttributes(entry.Key) & FileAttributes.ReparsePoint) != 0) continue;
                    foreach (string name in names)
                    {
                        string file = Path.Combine(entry.Key, name);
                        if (File.Exists(file) && file.IndexOf("\\Microsoft\\WindowsApps\\", StringComparison.OrdinalIgnoreCase) < 0)
                            LocalResourceHints.Add(found, file);
                    }
                    if (entry.Value >= maxDepth) continue;
                    foreach (string child in Directory.GetDirectories(entry.Key))
                        if (!Skip.Contains(Path.GetFileName(child))) pending.Enqueue(new KeyValuePair<string, int>(child, entry.Value + 1));
                }
                catch { }
            }
            return found;
        }
    }
}
