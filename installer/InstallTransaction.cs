using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

namespace LocalWhisperSubtitles.Setup
{
    internal sealed class InstallTransaction : IDisposable
    {
        private readonly List<Action> _rollback = new List<Action>();
        private readonly List<Action> _cleanup = new List<Action>();
        private bool _finished;

        public string CreateIncomingDirectory(string targetPath)
        {
            string parent = Path.GetDirectoryName(Path.GetFullPath(targetPath));
            Directory.CreateDirectory(parent);
            string incoming = targetPath + ".incoming-" + Guid.NewGuid().ToString("N");
            Directory.CreateDirectory(incoming);
            _cleanup.Add(delegate { SafeFileSystem.DeleteDirectory(incoming); });
            return incoming;
        }

        public void ReplaceDirectory(string incomingPath, string targetPath)
        {
            string incoming = Path.GetFullPath(incomingPath);
            string target = Path.GetFullPath(targetPath);
            if (!Directory.Exists(incoming)) throw new DirectoryNotFoundException("Prepared directory does not exist: " + incoming);

            string backup = target + ".backup-" + Guid.NewGuid().ToString("N");
            bool hadOriginal = Directory.Exists(target);
            if (hadOriginal) Directory.Move(target, backup);
            try
            {
                Directory.Move(incoming, target);
            }
            catch
            {
                if (hadOriginal && Directory.Exists(backup) && !Directory.Exists(target)) Directory.Move(backup, target);
                throw;
            }

            _rollback.Add(delegate
            {
                SafeFileSystem.DeleteDirectory(target);
                if (hadOriginal && Directory.Exists(backup)) Directory.Move(backup, target);
            });
            _cleanup.Add(delegate { SafeFileSystem.DeleteDirectory(backup); });
        }

        public void ReplaceFile(string sourcePath, string targetPath)
        {
            string source = Path.GetFullPath(sourcePath);
            string target = Path.GetFullPath(targetPath);
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase)) return;

            string parent = Path.GetDirectoryName(target);
            Directory.CreateDirectory(parent);
            string incoming = target + ".incoming-" + Guid.NewGuid().ToString("N");
            string backup = target + ".backup-" + Guid.NewGuid().ToString("N");
            File.Copy(source, incoming, true);

            bool hadOriginal = File.Exists(target);
            if (hadOriginal) File.Move(target, backup);
            try
            {
                File.Move(incoming, target);
            }
            catch
            {
                SafeFileSystem.DeleteFile(incoming);
                if (hadOriginal && File.Exists(backup) && !File.Exists(target)) File.Move(backup, target);
                throw;
            }

            _rollback.Add(delegate
            {
                SafeFileSystem.DeleteFile(target);
                if (hadOriginal && File.Exists(backup)) File.Move(backup, target);
            });
            _cleanup.Add(delegate
            {
                SafeFileSystem.DeleteFile(incoming);
                SafeFileSystem.DeleteFile(backup);
            });
        }

        public void RemoveDirectory(string targetPath)
        {
            string target = Path.GetFullPath(targetPath);
            if (!Directory.Exists(target)) return;
            string backup = target + ".removed-" + Guid.NewGuid().ToString("N");
            Directory.Move(target, backup);
            _rollback.Add(delegate { if (Directory.Exists(backup) && !Directory.Exists(target)) Directory.Move(backup, target); });
            _cleanup.Add(delegate { SafeFileSystem.DeleteDirectory(backup); });
        }

        public void RemoveFile(string targetPath)
        {
            string target = Path.GetFullPath(targetPath);
            if (!File.Exists(target)) return;
            string backup = target + ".removed-" + Guid.NewGuid().ToString("N");
            File.Move(target, backup);
            _rollback.Add(delegate { if (File.Exists(backup) && !File.Exists(target)) File.Move(backup, target); });
            _cleanup.Add(delegate { SafeFileSystem.DeleteFile(backup); });
        }

        public void WriteTextFile(string targetPath, string contents)
        {
            string temp = Path.Combine(Path.GetTempPath(), "LocalWhisperSubtitles-" + Guid.NewGuid().ToString("N") + ".tmp");
            File.WriteAllText(temp, contents, new UTF8Encoding(false));
            try { ReplaceFile(temp, targetPath); }
            finally { SafeFileSystem.DeleteFile(temp); }
        }

        public void ReplaceRegistryKey(RegistryKey root, string subKeyPath, IDictionary<string, RegistryEntry> values)
        {
            RegistryKeySnapshot snapshot = RegistryKeySnapshot.Capture(root, subKeyPath);
            using (RegistryKey key = root.CreateSubKey(subKeyPath))
            {
                if (key == null) throw new InvalidOperationException("Could not create registry key: " + subKeyPath);
                foreach (KeyValuePair<string, RegistryEntry> pair in values)
                {
                    key.SetValue(pair.Key, pair.Value.Value, pair.Value.Kind);
                }
            }
            _rollback.Add(delegate { snapshot.Restore(root, subKeyPath); });
        }

        public void SetRegistryValue(RegistryKey root, string subKeyPath, string name, object value, RegistryValueKind kind)
        {
            bool keyExisted;
            bool valueExisted = false;
            object oldValue = null;
            RegistryValueKind oldKind = RegistryValueKind.Unknown;
            using (RegistryKey existing = root.OpenSubKey(subKeyPath))
            {
                keyExisted = existing != null;
                if (existing != null)
                {
                    string[] names = existing.GetValueNames();
                    for (int i = 0; i < names.Length; i++)
                    {
                        if (!string.Equals(names[i], name, StringComparison.OrdinalIgnoreCase)) continue;
                        valueExisted = true;
                        oldValue = existing.GetValue(name, null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                        oldKind = existing.GetValueKind(name);
                        break;
                    }
                }
            }

            using (RegistryKey key = root.CreateSubKey(subKeyPath))
            {
                if (key == null) throw new InvalidOperationException("Could not create registry key: " + subKeyPath);
                key.SetValue(name, value, kind);
            }

            _rollback.Add(delegate
            {
                using (RegistryKey key = root.OpenSubKey(subKeyPath, true))
                {
                    if (key == null) return;
                    if (valueExisted) key.SetValue(name, oldValue, oldKind);
                    else key.DeleteValue(name, false);
                }
                if (!keyExisted) TryDeleteEmptyKey(root, subKeyPath);
            });
        }

        public void DeleteRegistryKey(RegistryKey root, string subKeyPath)
        {
            RegistryKeySnapshot snapshot = RegistryKeySnapshot.Capture(root, subKeyPath);
            try { root.DeleteSubKeyTree(subKeyPath, false); }
            catch (ArgumentException) { }
            _rollback.Add(delegate { snapshot.Restore(root, subKeyPath); });
        }

        public void Commit()
        {
            if (_finished) return;
            _finished = true;
            for (int i = _cleanup.Count - 1; i >= 0; i--)
            {
                try { _cleanup[i](); }
                catch { }
            }
            _rollback.Clear();
        }

        public void Rollback()
        {
            if (_finished) return;
            _finished = true;
            List<Exception> errors = new List<Exception>();
            for (int i = _rollback.Count - 1; i >= 0; i--)
            {
                try { _rollback[i](); }
                catch (Exception exception) { errors.Add(exception); }
            }
            for (int i = _cleanup.Count - 1; i >= 0; i--)
            {
                try { _cleanup[i](); }
                catch { }
            }
            if (errors.Count > 0) throw new AggregateException("Rollback did not complete cleanly.", errors);
        }

        public void Dispose()
        {
            if (!_finished) Rollback();
        }

        private static void TryDeleteEmptyKey(RegistryKey root, string subKeyPath)
        {
            try
            {
                using (RegistryKey key = root.OpenSubKey(subKeyPath))
                {
                    if (key == null || key.ValueCount != 0 || key.SubKeyCount != 0) return;
                }
                root.DeleteSubKey(subKeyPath, false);
            }
            catch { }
        }
    }

    internal sealed class RegistryEntry
    {
        public object Value { get; private set; }
        public RegistryValueKind Kind { get; private set; }

        public RegistryEntry(object value, RegistryValueKind kind)
        {
            Value = value;
            Kind = kind;
        }
    }

    internal sealed class RegistryKeySnapshot
    {
        private readonly bool _existed;
        private readonly Dictionary<string, RegistryEntry> _values;

        private RegistryKeySnapshot(bool existed, Dictionary<string, RegistryEntry> values)
        {
            _existed = existed;
            _values = values;
        }

        public static RegistryKeySnapshot Capture(RegistryKey root, string subKeyPath)
        {
            Dictionary<string, RegistryEntry> values = new Dictionary<string, RegistryEntry>(StringComparer.OrdinalIgnoreCase);
            using (RegistryKey key = root.OpenSubKey(subKeyPath))
            {
                if (key == null) return new RegistryKeySnapshot(false, values);
                string[] names = key.GetValueNames();
                for (int i = 0; i < names.Length; i++)
                {
                    object value = key.GetValue(names[i], null, RegistryValueOptions.DoNotExpandEnvironmentNames);
                    values[names[i]] = new RegistryEntry(value, key.GetValueKind(names[i]));
                }
                return new RegistryKeySnapshot(true, values);
            }
        }

        public void Restore(RegistryKey root, string subKeyPath)
        {
            if (!_existed)
            {
                try { root.DeleteSubKeyTree(subKeyPath, false); }
                catch (ArgumentException) { }
                return;
            }

            using (RegistryKey key = root.CreateSubKey(subKeyPath))
            {
                string[] current = key.GetValueNames();
                for (int i = 0; i < current.Length; i++) key.DeleteValue(current[i], false);
                foreach (KeyValuePair<string, RegistryEntry> pair in _values)
                {
                    key.SetValue(pair.Key, pair.Value.Value, pair.Value.Kind);
                }
            }
        }
    }

    internal static class SafeZipExtractor
    {
        public static void Extract(string archivePath, string destination)
        {
            string fullDestination = Path.GetFullPath(destination);
            Directory.CreateDirectory(fullDestination);
            using (FileStream stream = File.OpenRead(archivePath))
            using (ZipArchive archive = new ZipArchive(stream, ZipArchiveMode.Read, false))
            {
                foreach (ZipArchiveEntry entry in archive.Entries)
                {
                    int unixFileType = (entry.ExternalAttributes >> 16) & 0xF000;
                    if (unixFileType == 0xA000) throw new InvalidDataException("Symbolic links are not allowed in resource archives: " + entry.FullName);
                    string normalized = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                    if (string.IsNullOrWhiteSpace(normalized)) continue;
                    string target = PathSafety.ResolveChildPath(fullDestination, normalized);
                    if (string.IsNullOrEmpty(entry.Name))
                    {
                        Directory.CreateDirectory(target);
                        continue;
                    }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream input = entry.Open())
                    using (FileStream output = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    {
                        input.CopyTo(output);
                    }
                }
            }
        }

        public static void Extract(Stream zipStream, string destination)
        {
            string temp = Path.Combine(Path.GetTempPath(), "LocalWhisperSubtitles-" + Guid.NewGuid().ToString("N") + ".zip");
            using (FileStream output = File.Create(temp)) zipStream.CopyTo(output);
            try { Extract(temp, destination); }
            finally { SafeFileSystem.DeleteFile(temp); }
        }
    }

    internal static class SafeFileSystem
    {
        public static void DeleteDirectory(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !Directory.Exists(path)) return;
            FileAttributes rootAttributes = File.GetAttributes(path);
            if ((rootAttributes & FileAttributes.ReparsePoint) != 0)
            {
                Directory.Delete(path, false);
                return;
            }

            string[] entries = Directory.GetFileSystemEntries(path, "*", SearchOption.TopDirectoryOnly);
            for (int i = 0; i < entries.Length; i++)
            {
                FileAttributes attributes = File.GetAttributes(entries[i]);
                bool isDirectory = (attributes & FileAttributes.Directory) != 0;
                bool isReparsePoint = (attributes & FileAttributes.ReparsePoint) != 0;
                if (isDirectory && !isReparsePoint)
                {
                    DeleteDirectory(entries[i]);
                }
                else if (isDirectory)
                {
                    Directory.Delete(entries[i], false);
                }
                else
                {
                    File.SetAttributes(entries[i], FileAttributes.Normal);
                    File.Delete(entries[i]);
                }
            }
            File.SetAttributes(path, FileAttributes.Directory);
            Directory.Delete(path, false);
        }

        public static void DeleteFile(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return;
            File.SetAttributes(path, FileAttributes.Normal);
            File.Delete(path);
        }
    }
}
