using System;

namespace LocalWhisperSubtitles.Setup
{
    internal static class RuntimeCompatibility
    {
        public static bool CanRun(ModelCandidate model, InspectionResult result)
        {
            if (model == null || result == null) return false;
            if (model.Format == "ggml-bin" || model.Format == "gguf")
                return !string.IsNullOrWhiteSpace(result.ExistingRuntimePath) || !string.IsNullOrWhiteSpace(result.ExistingVulkanRuntimePath);
            return result.GpuRuntime != null && result.GpuRuntime.PythonForModel(model.Format) != null;
        }
    }
}
