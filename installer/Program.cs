using System;

namespace LocalWhisperSubtitles.Setup
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            return NsisBridge.Run(args);
        }
    }
}
