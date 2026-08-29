using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Web.Script.Serialization;

namespace LocalWhisperSubtitles.Setup
{
    internal sealed class ResourceCatalog
    {
        private readonly string _root;

        public string Root { get { return _root; } }
        public ResourceManifest Manifest { get; private set; }

        private ResourceCatalog(string root, ResourceManifest manifest)
        {
            _root = Path.GetFullPath(root);
            Manifest = manifest;
        }

        public static ResourceCatalog Load(string resourcesRoot)
        {
            if (string.IsNullOrWhiteSpace(resourcesRoot)) throw new ArgumentException("Resources root is required.", "resourcesRoot");
            string manifestPath = Path.Combine(resourcesRoot, "manifest.json");
            if (!File.Exists(manifestPath)) throw new FileNotFoundException("External resources manifest was not found.", manifestPath);

            string json = File.ReadAllText(manifestPath);
            ResourceManifest manifest;
            try
            {
                manifest = new JavaScriptSerializer().Deserialize<ResourceManifest>(json);
            }
            catch (Exception exception)
            {
                throw new InvalidDataException("External resources manifest is invalid JSON.", exception);
            }

            if (manifest == null || string.IsNullOrWhiteSpace(manifest.schemaVersion))
                throw new InvalidDataException("External resources manifest has no schemaVersion.");
            if (!manifest.schemaVersion.StartsWith("1.", StringComparison.Ordinal))
                throw new InvalidDataException("Unsupported resource manifest schema: " + manifest.schemaVersion);
            if (!string.Equals(manifest.integrityAlgorithm, "SHA-256", StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Resource manifest must use SHA-256 integrity.");

            if (manifest.runtimes == null) manifest.runtimes = new List<ResourcePackage>();
            if (manifest.models == null) manifest.models = new List<ResourcePackage>();
            if (manifest.vadModels == null) manifest.vadModels = new List<ResourcePackage>();
            if (manifest.licenses == null) manifest.licenses = new List<ResourceLicense>();
            EnsureUniqueIds(manifest.runtimes, manifest.models, manifest.vadModels);

            return new ResourceCatalog(resourcesRoot, manifest);
        }

        public ResourcePackage FindCpuRuntime()
        {
            for (int i = 0; i < Manifest.runtimes.Count; i++)
            {
                ResourcePackage item = Manifest.runtimes[i];
                if (string.Equals(item.backend, "cpu", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(item.architecture, "x64", StringComparison.OrdinalIgnoreCase)) return item;
            }
            return null;
        }

        public ResourcePackage FindVulkanRuntime()
        {
            for (int i = 0; i < Manifest.runtimes.Count; i++)
            {
                ResourcePackage item = Manifest.runtimes[i];
                if (string.Equals(item.backend, "vulkan", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(item.architecture, "x64", StringComparison.OrdinalIgnoreCase)) return item;
            }
            return null;
        }

        public ResourcePackage FindRecommendedModel()
        {
            for (int i = 0; i < Manifest.models.Count; i++)
            {
                if (Manifest.models[i].recommended) return Manifest.models[i];
            }
            return null;
        }

        public ResourcePackage FindRecommendedVadModel()
        {
            for (int i = 0; i < Manifest.vadModels.Count; i++)
            {
                ResourcePackage item = Manifest.vadModels[i];
                if (item != null
                    && item.recommended
                    && string.Equals(item.kind, "vad-model", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(item.backend, "whisper.cpp", StringComparison.OrdinalIgnoreCase)) return item;
            }
            return null;
        }

        public ResourceValidation Validate(ResourcePackage package)
        {
            ResourceValidation result = new ResourceValidation { Package = package, IsValid = false };
            if (package == null)
            {
                result.Error = "No matching resource is declared.";
                return result;
            }
            if (string.IsNullOrWhiteSpace(package.localPath))
            {
                result.Error = "The resource is not present in the external bundle.";
                return result;
            }

            try
            {
                result.FullPath = PathSafety.ResolveChildPath(_root, package.localPath);
            }
            catch (Exception exception)
            {
                result.Error = exception.Message;
                return result;
            }

            if (!File.Exists(result.FullPath))
            {
                result.Error = "File is missing: " + package.localPath;
                return result;
            }
            if (package.size <= 0)
            {
                result.Error = "Manifest size is missing for bundled resource: " + package.id;
                return result;
            }
            FileInfo info = new FileInfo(result.FullPath);
            if (info.Length != package.size)
            {
                result.Error = string.Format(CultureInfo.InvariantCulture, "Size mismatch for {0}: expected {1}, actual {2}.", package.id, package.size, info.Length);
                return result;
            }
            if (string.IsNullOrWhiteSpace(package.sha256) || package.sha256.Length != 64)
            {
                result.Error = "Manifest SHA-256 is missing for bundled resource: " + package.id;
                return result;
            }

            string actual = ComputeSha256(result.FullPath);
            if (!string.Equals(actual, package.sha256, StringComparison.OrdinalIgnoreCase))
            {
                result.Error = "SHA-256 mismatch for " + package.id + ".";
                return result;
            }

            result.IsValid = true;
            return result;
        }

        public string ResolveLicense(ResourceLicense license)
        {
            if (license == null || string.IsNullOrWhiteSpace(license.textPath)) return null;
            string path = PathSafety.ResolveChildPath(_root, license.textPath);
            return File.Exists(path) ? path : null;
        }

        public static string ComputeSha256(string filePath)
        {
            using (FileStream stream = File.OpenRead(filePath))
            using (SHA256 hash = SHA256.Create())
            {
                byte[] bytes = hash.ComputeHash(stream);
                return BitConverter.ToString(bytes).Replace("-", string.Empty).ToLowerInvariant();
            }
        }

        private static void EnsureUniqueIds(List<ResourcePackage> runtimes, List<ResourcePackage> models, List<ResourcePackage> vadModels)
        {
            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            List<ResourcePackage> all = new List<ResourcePackage>();
            all.AddRange(runtimes);
            all.AddRange(models);
            all.AddRange(vadModels);
            for (int i = 0; i < all.Count; i++)
            {
                if (all[i] == null || string.IsNullOrWhiteSpace(all[i].id)) throw new InvalidDataException("Every resource must have an id.");
                if (!ids.Add(all[i].id)) throw new InvalidDataException("Duplicate resource id: " + all[i].id);
            }
        }
    }
}
