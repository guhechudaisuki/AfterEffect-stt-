using System;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

namespace LocalWhisperSubtitles.Setup
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            bool uninstall = HasArgument(args, "--uninstall");
            bool quiet = HasArgument(args, "--quiet");
            bool selfTest = HasArgument(args, "--self-test");
            InstallerEngine engine = new InstallerEngine(Assembly.GetExecutingAssembly().Location);

            if (selfTest)
            {
                try
                {
                    engine.SelfTest();
                    Environment.ExitCode = 0;
                }
                catch
                {
                    Environment.ExitCode = 1;
                }
                return;
            }

            if (quiet)
            {
                try
                {
                    if (!uninstall) throw new InvalidOperationException("Quiet install is disabled because license consent is required.");
                    engine.Uninstall(null);
                    Environment.ExitCode = 0;
                }
                catch
                {
                    Environment.ExitCode = 1;
                }
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs eventArgs)
            {
                MessageBox.Show(eventArgs.Exception.Message, ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            };
            Application.Run(new MainForm(engine, uninstall));
        }

        private static bool HasArgument(string[] args, string expected)
        {
            for (int i = 0; i < args.Length; i++)
                if (string.Equals(args[i], expected, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }
    }
}
