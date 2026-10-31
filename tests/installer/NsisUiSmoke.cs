using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class NsisUiSmoke
{
    private delegate bool EnumProc(IntPtr handle, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr state);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint id);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, IntPtr count, StringBuilder text, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr handle, int id);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr handle, IntPtr dc, uint flags);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left,Top,Right,Bottom; }
    private static string Text(IntPtr handle) { StringBuilder b = new StringBuilder(32768); IntPtr result; SendMessageTimeout(handle,0x000D,new IntPtr(b.Capacity),b,2,300,out result); return b.ToString(); }
    private static List<IntPtr> Controls(IntPtr parent) { List<IntPtr> controls=new List<IntPtr>(); EnumChildWindows(parent,delegate(IntPtr h,IntPtr s){ controls.Add(h); return true; },IntPtr.Zero); return controls; }
    private static IntPtr Find(IntPtr parent,string prefix) { foreach(IntPtr h in Controls(parent)) if(Text(h).StartsWith(prefix,StringComparison.Ordinal)) return h; return IntPtr.Zero; }
    private static void Require(bool value,string message) { if(!value) throw new Exception(message); }
    private static void Click(IntPtr handle) { Require(handle!=IntPtr.Zero,"Control not found"); PostMessage(handle,0xF5,IntPtr.Zero,IntPtr.Zero); Thread.Sleep(200); }
    private static IntPtr Wait(Func<IntPtr> lookup,int timeout) { Stopwatch timer=Stopwatch.StartNew(); while(timer.ElapsedMilliseconds<timeout){ IntPtr h=lookup(); if(h!=IntPtr.Zero)return h; Thread.Sleep(100); } return IntPtr.Zero; }
    private static void Capture(IntPtr window,string file)
    {
        Rect r; GetWindowRect(window,out r);
        using(Bitmap image=new Bitmap(r.Right-r.Left,r.Bottom-r.Top))
        using(Graphics graphics=Graphics.FromImage(image))
        {
            IntPtr dc=graphics.GetHdc(); try { Require(PrintWindow(window,dc,2),"Window capture failed"); } finally { graphics.ReleaseHdc(dc); }
            image.Save(file,ImageFormat.Png);
        }
    }
    private static int Main(string[] args)
    {
        Process process=null;
        try
        {
            Directory.CreateDirectory(args[1]);
            process=Process.Start(new ProcessStartInfo(Path.GetFullPath(args[0])) { UseShellExecute=false, CreateNoWindow=true, WindowStyle=ProcessWindowStyle.Hidden });
            IntPtr window=Wait(delegate { IntPtr result=IntPtr.Zero; EnumWindows(delegate(IntPtr h,IntPtr s){ uint id; GetWindowThreadProcessId(h,out id); if(id==process.Id && Text(h).StartsWith("Local Whisper Subtitles")){result=h;return false;} return true; },IntPtr.Zero); return result; },10000);
            Require(window!=IntPtr.Zero,"Native NSIS window did not start");
            // Keep the native dialog paintable; do not activate it or Adobe apps.
            IntPtr ae=Find(window,"After Effects（"), pr=Find(window,"Premiere Pro（"), stt=Find(window,"安装字幕识别 STT"), gpu=Find(window,"GPU 加速");
            Require(ae!=IntPtr.Zero && pr!=IntPtr.Zero && stt!=IntPtr.Zero && gpu!=IntPtr.Zero,"Quick-install controls are missing");
            Require(SendMessage(ae,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32()==1,"AE must default on");
            Require(SendMessage(stt,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32()==0,"STT must default off");
            Require(!IsWindowEnabled(gpu),"GPU must stay disabled when STT is off");
            Thread.Sleep(250);
            Capture(window,Path.Combine(args[1],"nsis-quick.png"));
            Console.WriteLine("PASS: native quick page defaults and screenshot");
            Click(pr);
            Require(SendMessage(stt,0xF0,IntPtr.Zero,IntPtr.Zero).ToInt32()==1 && !IsWindowEnabled(stt),"PR did not enforce STT");
            Require(IsWindowEnabled(gpu),"Optional Vulkan control did not enable");
            Console.WriteLine("PASS: PR requires STT and enables optional Vulkan");
            Click(pr); Click(stt);
            IntPtr custom=Find(window,"自定义安装…");
            Require(custom!=IntPtr.Zero,"Custom route is missing");
            // nsDialogs links notify their parent with a normal click command.
            PostMessage(GetParent(custom),0x0111,new IntPtr(GetDlgCtrlID(custom)),custom);
            IntPtr refresh=Wait(delegate {return Find(window,"扫描指定目录 / 重新检测");},10000);
            if (refresh==IntPtr.Zero) { foreach(IntPtr h in Controls(window)) Console.WriteLine("CONTROL: "+Text(h)); Capture(window,Path.Combine(args[1],"nsis-failure.png")); }
            Require(refresh!=IntPtr.Zero,"Custom-install page did not open");
            Console.WriteLine("PASS: custom page route");
            IntPtr status=Wait(delegate {foreach(IntPtr h in Controls(window)) if(Text(h).StartsWith("找到 "))return h; return IntPtr.Zero;},110000);
            Require(status!=IntPtr.Zero,"Custom resource detection did not finish");
            Capture(window,Path.Combine(args[1],"nsis-custom.png"));
            IntPtr back=GetDlgItem(window,3);
            Require(IsWindowEnabled(back),"Return to quick installation is disabled");
            Click(back);
            Require(Wait(delegate{return Find(window,"After Effects（");},5000)!=IntPtr.Zero,"Back did not restore quick-install page");
            Click(GetDlgItem(window,1));
            Require(Wait(delegate{return Find(window,"确认安装");},30000)!=IntPtr.Zero,"Quick effect-copy did not reach confirmation without a license/download step");
            Capture(window,Path.Combine(args[1],"nsis-confirm-effects.png"));
            Click(GetDlgItem(window,3));
            stt=Wait(delegate{return Find(window,"安装字幕识别 STT");},5000);
            Click(stt);
            Click(GetDlgItem(window,1));
            IntPtr accept=Wait(delegate { foreach(IntPtr h in Controls(window)) if(Text(h).Contains("接受") && Text(h).Contains("协议"))return h; return IntPtr.Zero; },30000);
            Require(accept!=IntPtr.Zero,"Quick STT download license consent is missing");
            Require(!IsWindowEnabled(GetDlgItem(window,1)),"Download consent must be explicit");
            Capture(window,Path.Combine(args[1],"nsis-license.png"));
            Click(accept);
            Click(GetDlgItem(window,1));
            Require(Wait(delegate{return Find(window,"确认安装");},5000)!=IntPtr.Zero,"STT download confirmation did not open");
            Capture(window,Path.Combine(args[1],"nsis-confirm-stt.png"));
            Console.WriteLine("PASS: native NSIS defaults, PR/STT gating, custom detection, back navigation and screenshots (no install executed)");
            return 0;
        }
        catch(Exception error) { Console.Error.WriteLine("FAIL: "+error.Message); return 1; }
        finally { if(process!=null){ if(!process.HasExited)process.Kill(); process.Dispose(); } }
    }
}
