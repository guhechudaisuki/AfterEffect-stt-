using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Windows.Forms;

namespace LocalWhisperSubtitles.Setup
{
    internal sealed class MainForm : Form
    {
        private static readonly Color Ink = Color.FromArgb(31, 34, 38);
        private static readonly Color Canvas = Color.FromArgb(246, 247, 249);
        private static readonly Color Accent = Color.FromArgb(211, 45, 53);
        private static readonly Color Success = Color.FromArgb(24, 125, 82);
        private static readonly Color Warning = Color.FromArgb(165, 96, 16);

        private readonly InstallerEngine _engine;
        private readonly bool _uninstallMode;
        private readonly Label _hostStatus;
        private readonly Label _resourceStatus;
        private readonly Label _runtimeStatus;
        private readonly Label _gpuStatus;
        private readonly Label _modelStatus;
        private readonly CheckBox _installCpu;
        private readonly CheckBox _acceptLicense;
        private readonly Button _primaryButton;
        private readonly Button _uninstallButton;
        private readonly Button _closeButton;
        private readonly ProgressBar _progress;
        private readonly TextBox _log;
        private readonly Label _selectedHostPaths;
        private readonly Label _selectedPythonPath;
        private readonly CheckBox _installAfterEffects;
        private readonly CheckBox _installPremiere;
        private readonly CheckBox _installEffectCopy;
        private readonly CheckBox _installVulkan;
        private readonly RadioButton _quickInstall;
        private readonly RadioButton _customInstall;
        private readonly FlowLayoutPanel _modelPathPanel;
        private readonly FlowLayoutPanel _pythonPathPanel;
        private readonly FlowLayoutPanel _quickModelPanel;
        private readonly CheckBox _quickNeedStt;
        private readonly Button _chooseQuickModelFolder;
        private readonly Label _quickModelFolderLabel;
        private TableLayoutPanel _customPage;
        private Panel _quickPage;
        private FlowLayoutPanel _modePanel;
        private Button _customInstallButton;
        private Button _backToQuickButton;
        private CheckBox _quickAfterEffects;
        private CheckBox _quickPremiere;
        private CheckBox _quickGpuAcceleration;
        private Label _quickCpuRuntimeLabel;
        private Button _chooseQuickAe;
        private string _aeExecutablePath;
        private string _prExecutablePath;
        private string _modelPath;
        private string _modelDestinationFolder;
        private string _pythonExecutablePath;
        private InspectionResult _inspection;
        private bool _busy;
        private bool _lastCustomMode;
        private bool _syncingQuickHosts;
        private bool _syncingQuickRuntime;

        public MainForm(InstallerEngine engine, bool uninstallMode)
        {
            _engine = engine;
            _uninstallMode = uninstallMode;

            Text = uninstallMode ? "卸载 " + ProductInfo.Name : ProductInfo.Name + " 安装";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(680, 650);
            ClientSize = new Size(760, 700);
            BackColor = Canvas;
            Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

            TableLayoutPanel root = new TableLayoutPanel();
            root.Dock = DockStyle.Fill;
            root.ColumnCount = 1;
            root.RowCount = 4;
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 92F));
            root.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 76F));
            root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48F));
            Controls.Add(root);

            Panel header = new Panel { Dock = DockStyle.Fill, BackColor = Ink, Padding = new Padding(26, 16, 26, 12) };
            Label title = new Label
            {
                AutoSize = true,
                ForeColor = Color.White,
                Font = new Font("Segoe UI Semibold", 17F, FontStyle.Bold),
                Text = uninstallMode ? "移除本地字幕工作区" : "安装本地字幕工作区",
                Location = new Point(22, 15)
            };
            Label subtitle = new Label
            {
                AutoSize = true,
                ForeColor = Color.FromArgb(188, 194, 201),
                Text = "After Effects / Premiere Pro 2020+  ·  本地 Whisper  ·  当前用户",
                Location = new Point(25, 53)
            };
            Panel accentLine = new Panel { BackColor = Accent, Dock = DockStyle.Bottom, Height = 4 };
            header.Controls.Add(title);
            header.Controls.Add(subtitle);
            header.Controls.Add(accentLine);
            root.Controls.Add(header, 0, 0);

            TableLayoutPanel body = new TableLayoutPanel
            {
                Dock = DockStyle.Fill,
                AutoScroll = true,
                Padding = new Padding(26, 20, 26, 10),
                ColumnCount = 2,
                RowCount = 10
            };
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 150F));
            body.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            for (int i = 0; i < 10; i++) body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            _customPage = body;

            _hostStatus = AddStatusRow(body, 0, "Adobe 宿主", "正在检测...");
            _resourceStatus = AddStatusRow(body, 1, "外置资源", "正在校验 manifest...");
            _runtimeStatus = AddStatusRow(body, 2, "CPU Whisper 运行时", "正在检测本地 CPU 后端...");
            _gpuStatus = AddStatusRow(body, 3, "GPU Whisper / Vulkan 运行时", "正在检测本地 CUDA/Vulkan 后端...");
            _modelStatus = AddStatusRow(body, 4, "Whisper 模型", "正在检测...");

            body.Controls.Add(new Label { AutoSize = true, Text = "宿主路径", Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 11, 12, 8) }, 0, 5);
            FlowLayoutPanel hostPathPanel = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                Margin = new Padding(0, 7, 0, 7)
            };
            _installAfterEffects = new CheckBox { AutoSize = true, Text = "After Effects", Checked = true, Margin = new Padding(0, 5, 8, 5) };
            _installPremiere = new CheckBox { AutoSize = true, Text = "Premiere Pro", Checked = false, Margin = new Padding(0, 5, 8, 5) };
            Button chooseAe = new Button { AutoSize = true, Text = "选择 AE 可执行文件" };
            chooseAe.Click += delegate { ChooseHostExecutable("AEFT"); };
            Button choosePr = new Button { AutoSize = true, Text = "选择 PR 可执行文件" };
            choosePr.Click += delegate { ChooseHostExecutable("PPRO"); };
            _selectedHostPaths = new Label { AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Color.FromArgb(87, 91, 97), Text = "未指定；安装器将自动探测标准路径" };
            hostPathPanel.Controls.Add(_installAfterEffects);
            hostPathPanel.Controls.Add(_installPremiere);
            hostPathPanel.Controls.Add(chooseAe);
            hostPathPanel.Controls.Add(choosePr);
            hostPathPanel.Controls.Add(_selectedHostPaths);
            body.Controls.Add(hostPathPanel, 1, 5);

            body.Controls.Add(new Label { AutoSize = true, Text = "模型路径", Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 11, 12, 8) }, 0, 6);
            _modelPathPanel = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                Margin = new Padding(0, 7, 0, 7)
            };
            Button chooseModel = new Button { AutoSize = true, Text = "指定 Whisper 模型" };
            chooseModel.Click += delegate { ChooseModel(); };
            Button chooseModelDirectory = new Button { AutoSize = true, Text = "\u6307\u5B9A\u6A21\u578B\u76EE\u5F55" };
            chooseModelDirectory.Click += delegate { ChooseModelDirectory(); };
            _modelPathPanel.Controls.Add(chooseModel);
            _modelPathPanel.Controls.Add(chooseModelDirectory);
            body.Controls.Add(_modelPathPanel, 1, 6);

            body.Controls.Add(new Label { AutoSize = true, Text = "Python 运行时", Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 11, 12, 8) }, 0, 7);
            _pythonPathPanel = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                Margin = new Padding(0, 7, 0, 7)
            };
            Button choosePython = new Button { AutoSize = true, Text = "指定 Python 运行时" };
            choosePython.Click += delegate { ChoosePythonExecutable(); };
            _selectedPythonPath = new Label { AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Color.FromArgb(87, 91, 97), Text = "未指定；仅自动检测标准 Python/Conda 环境" };
            _pythonPathPanel.Controls.Add(choosePython);
            _pythonPathPanel.Controls.Add(_selectedPythonPath);
            body.Controls.Add(_pythonPathPanel, 1, 7);

            FlowLayoutPanel choices = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                Margin = new Padding(0, 8, 0, 8)
            };
            FlowLayoutPanel modePanel = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, WrapContents = false, Margin = new Padding(0, 0, 0, 4), Visible = false };
            _modePanel = modePanel;
            _quickInstall = new RadioButton { AutoSize = true, Text = "快速安装", Checked = true, Margin = new Padding(0, 0, 12, 0) };
            _customInstall = new RadioButton { AutoSize = true, Text = "自定义安装" };
            modePanel.Controls.Add(_quickInstall);
            modePanel.Controls.Add(_customInstall);
            _installEffectCopy = new CheckBox { AutoSize = true, Text = "AE 效果复制（选择 AE 后必装）", Checked = true, Enabled = false };
            _installCpu = new CheckBox { AutoSize = true, Text = "安装外置通用 CPU 运行时（CPU STT / whisper.cpp）", Checked = false };
            _installVulkan = new CheckBox { AutoSize = true, Text = "安装 Vulkan GPU+CPU 混合 STT（无需 CUDA/PyTorch）", Checked = false };
            _acceptLicense = new CheckBox { AutoSize = true, Text = "我已阅读并接受外置运行时的第三方许可证" };
            LinkLabel licenseLink = new LinkLabel { AutoSize = true, Text = "查看许可证", LinkColor = Accent };
            licenseLink.LinkClicked += delegate { OpenRuntimeLicense(); };
            _installCpu.CheckedChanged += delegate { if (!_syncingQuickRuntime) UpdateActionState(); };
            _installVulkan.CheckedChanged += delegate { if (!_syncingQuickRuntime) UpdateActionState(); };
            _installAfterEffects.CheckedChanged += delegate { SyncEffectCopyRequirement(); SyncQuickHostSelection(); UpdateActionState(); };
            _installPremiere.CheckedChanged += delegate { SyncQuickHostSelection(); UpdateActionState(); };
            _installEffectCopy.CheckedChanged += delegate { UpdateActionState(); };
            _acceptLicense.CheckedChanged += delegate { UpdateActionState(); };
            _quickInstall.CheckedChanged += delegate { UpdateInstallMode(); };
            _customInstall.CheckedChanged += delegate { UpdateInstallMode(); };
            choices.Controls.Add(modePanel);
            _backToQuickButton = CreateNavigationButton("← 返回快速安装");
            _backToQuickButton.Click += delegate { _quickInstall.Checked = true; };
            choices.Controls.Add(_backToQuickButton);
            choices.Controls.Add(_installEffectCopy);
            Label customResourceHint = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(520, 0),
                ForeColor = Color.FromArgb(87, 91, 97),
                Text = "自定义安装仅接入你已有的 Whisper 模型和运行环境。安装器不会下载模型、CPU/Vulkan runtime，也不会要求第三方运行时许可证；请自行准备 CPU whisper.cpp、Vulkan 或 CUDA/PyTorch 环境。",
                Margin = new Padding(0, 2, 0, 8)
            };
            choices.Controls.Add(customResourceHint);
            // Runtime and license controls remain internal state for
            // quick-install automation, but are never shown on custom mode.
            _installCpu.Visible = false;
            _installVulkan.Visible = false;
            _acceptLicense.Visible = false;
            _quickModelPanel = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                Margin = new Padding(0, 4, 0, 0),
                Padding = new Padding(0)
            };
            _quickNeedStt = new CheckBox { AutoSize = true, Text = "安装字幕识别 STT（默认 CPU）", Margin = new Padding(0, 3, 8, 3) };
            _quickNeedStt.CheckedChanged += delegate { UpdateInstallMode(); };
            _quickCpuRuntimeLabel = new Label { AutoSize = true, Text = "CPU 计算：安装 CPU whisper.cpp 运行时（STT 必需）", ForeColor = Color.FromArgb(87, 91, 97), Margin = new Padding(22, 5, 0, 3) };
            _quickGpuAcceleration = new CheckBox { AutoSize = true, Text = "GPU 加速（Vulkan GPU+CPU，无需 CUDA/PyTorch）", Margin = new Padding(0, 3, 8, 3), Enabled = false };
            _quickGpuAcceleration.CheckedChanged += delegate
            {
                if (_syncingQuickRuntime) return;
                _installVulkan.Checked = _quickGpuAcceleration.Checked;
                UpdateActionState();
            };
            FlowLayoutPanel quickModelDestinationPanel = new FlowLayoutPanel
            {
                AutoSize = true,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                Margin = new Padding(0, 2, 0, 0)
            };
            _chooseQuickModelFolder = new Button { AutoSize = true, Text = "更改下载目录（可选）" };
            _chooseQuickModelFolder.Click += delegate { ChooseQuickModelFolder(); };
            _quickModelFolderLabel = new Label { AutoSize = true, MaximumSize = new Size(410, 0), ForeColor = Color.FromArgb(87, 91, 97), Text = "未选择文件夹", Margin = new Padding(0, 8, 0, 0) };
            quickModelDestinationPanel.Controls.Add(_chooseQuickModelFolder);
            quickModelDestinationPanel.Controls.Add(_quickModelFolderLabel);
            _quickModelPanel.Controls.Add(_quickNeedStt);
            _quickModelPanel.Controls.Add(_quickCpuRuntimeLabel);
            _quickModelPanel.Controls.Add(_quickGpuAcceleration);
            _quickModelPanel.Controls.Add(quickModelDestinationPanel);
            body.Controls.Add(new Label { AutoSize = true, Text = "安装选项", Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 11, 12, 8) }, 0, 8);
            body.Controls.Add(choices, 1, 8);

            _quickAfterEffects = new CheckBox { AutoSize = true, Text = "After Effects", Checked = true, Margin = new Padding(0, 5, 18, 5) };
            _quickPremiere = new CheckBox { AutoSize = true, Text = "Premiere Pro", Checked = false, Margin = new Padding(0, 5, 18, 5) };
            _quickAfterEffects.CheckedChanged += delegate
            {
                if (_syncingQuickHosts) return;
                _installAfterEffects.Checked = _quickAfterEffects.Checked;
                UpdateActionState();
            };
            _quickPremiere.CheckedChanged += delegate
            {
                if (_syncingQuickHosts) return;
                _installPremiere.Checked = _quickPremiere.Checked;
                UpdateActionState();
            };

            _quickPage = BuildQuickInstallPage();
            Panel pageHost = new Panel { Dock = DockStyle.Fill, BackColor = Canvas };
            pageHost.Controls.Add(_customPage);
            pageHost.Controls.Add(_quickPage);
            root.Controls.Add(pageHost, 0, 1);

            Label privacy = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(520, 0),
                ForeColor = Color.FromArgb(87, 91, 97),
                Text = "安装器不会静默下载模型。未检测到模型时，插件会提供推荐模型和用户自选路径。它会为当前用户启用 Adobe CEP 的 PlayerDebugMode，影响其他未签名 CEP 扩展；卸载时会保留该共享设置和外部模型。",
                Margin = new Padding(0, 10, 0, 0)
            };
            body.Controls.Add(new Label { AutoSize = true, Text = "数据边界", Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 11, 12, 8) }, 0, 9);
            body.Controls.Add(privacy, 1, 9);

            Panel activity = new Panel { Dock = DockStyle.Fill, Padding = new Padding(26, 8, 26, 4) };
            _progress = new ProgressBar { Dock = DockStyle.Top, Height = 5, Style = ProgressBarStyle.Blocks };
            _log = new TextBox
            {
                Dock = DockStyle.Bottom,
                Height = 48,
                Multiline = true,
                ReadOnly = true,
                BorderStyle = BorderStyle.None,
                BackColor = Canvas,
                ForeColor = Color.FromArgb(76, 81, 87),
                Text = "准备检测安装条件。"
            };
            activity.Controls.Add(_progress);
            activity.Controls.Add(_log);
            root.Controls.Add(activity, 0, 2);

            FlowLayoutPanel actions = new FlowLayoutPanel
            {
                Dock = DockStyle.Fill,
                FlowDirection = FlowDirection.RightToLeft,
                Padding = new Padding(26, 6, 26, 6),
                BackColor = Color.White
            };
            _primaryButton = CreateActionButton(uninstallMode ? "卸载" : "安装", true);
            _primaryButton.Click += delegate { if (uninstallMode) BeginUninstall(); else BeginInstall(); };
            _closeButton = CreateActionButton("关闭", false);
            _closeButton.Click += delegate { Close(); };
            _uninstallButton = CreateActionButton("卸载现有版本", false);
            _uninstallButton.Click += delegate { BeginUninstall(); };
            actions.Controls.Add(_primaryButton);
            actions.Controls.Add(_closeButton);
            if (!uninstallMode) actions.Controls.Add(_uninstallButton);
            root.Controls.Add(actions, 0, 3);

            Shown += delegate
            {
                InstallState installed = _engine.LoadInstallState();
                if (installed != null)
                {
                    _installAfterEffects.Checked = installed.installAfterEffects || (!installed.installAfterEffects && !installed.installPremiere);
                    _installPremiere.Checked = installed.installPremiere;
                    SyncEffectCopyRequirement();
                    _installCpu.Checked = installed.installCpuRuntime;
                    _installVulkan.Checked = installed.installVulkanRuntime;
                    if (!string.IsNullOrWhiteSpace(installed.modelPath) && (File.Exists(installed.modelPath) || Directory.Exists(installed.modelPath))) _modelPath = installed.modelPath;
                    if (!string.IsNullOrWhiteSpace(installed.modelDestinationFolder))
                    {
                        _modelDestinationFolder = installed.modelDestinationFolder;
                        _quickModelFolderLabel.Text = _modelDestinationFolder;
                    }
                    else if (!string.IsNullOrWhiteSpace(installed.modelPath) && File.Exists(installed.modelPath))
                    {
                        string modelFolder = Path.GetDirectoryName(installed.modelPath);
                        if (!string.IsNullOrWhiteSpace(modelFolder))
                        {
                            _modelDestinationFolder = modelFolder;
                            _quickModelFolderLabel.Text = modelFolder;
                        }
                    }
                    if (!string.IsNullOrWhiteSpace(installed.pythonExecutablePath) && File.Exists(installed.pythonExecutablePath))
                    {
                        _pythonExecutablePath = installed.pythonExecutablePath;
                        _selectedPythonPath.Text = _pythonExecutablePath;
                    }
                    if (!string.IsNullOrWhiteSpace(installed.vulkanRuntimePath) && File.Exists(installed.vulkanRuntimePath)) _installVulkan.Checked = false;
                }
                SyncQuickHostSelection();
                EnsureDefaultQuickModelFolder();
                UpdateInstallMode();
                RefreshInspection();
            };
            FormClosing += delegate(object sender, FormClosingEventArgs eventArgs)
            {
                if (!_busy) return;
                eventArgs.Cancel = true;
                System.Media.SystemSounds.Beep.Play();
            };
        }

        private Label AddStatusRow(TableLayoutPanel body, int row, string label, string initial)
        {
            Label name = new Label { AutoSize = true, Text = label, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 8, 12, 8) };
            Label value = new Label { AutoSize = true, MaximumSize = new Size(520, 0), Text = initial, ForeColor = Color.FromArgb(87, 91, 97), Margin = new Padding(0, 8, 0, 8) };
            body.Controls.Add(name, 0, row);
            body.Controls.Add(value, 1, row);
            return value;
        }

        private Button CreateActionButton(string text, bool primary)
        {
            Button button = new Button
            {
                AutoSize = false,
                Size = new Size(primary ? 126 : 112, 32),
                FlatStyle = FlatStyle.Flat,
                Text = text,
                BackColor = primary ? Accent : Color.White,
                ForeColor = primary ? Color.White : Ink,
                Margin = new Padding(8, 0, 0, 0)
            };
            button.FlatAppearance.BorderColor = primary ? Accent : Color.FromArgb(191, 195, 201);
            return button;
        }

        private Button CreateNavigationButton(string text)
        {
            Button button = new Button
            {
                AutoSize = true,
                FlatStyle = FlatStyle.Flat,
                FlatAppearance = { BorderSize = 0 },
                BackColor = Canvas,
                ForeColor = Accent,
                Text = text,
                Cursor = Cursors.Hand,
                Padding = new Padding(0, 2, 0, 2),
                Margin = new Padding(0, 2, 0, 6)
            };
            return button;
        }

        private Panel BuildQuickInstallPage()
        {
            Panel page = new Panel
            {
                Dock = DockStyle.Fill,
                AutoScroll = true,
                BackColor = Canvas,
                Padding = new Padding(42, 32, 42, 24)
            };

            TableLayoutPanel content = new TableLayoutPanel
            {
                Dock = DockStyle.Top,
                AutoSize = true,
                ColumnCount = 1,
                RowCount = 0,
                BackColor = Canvas
            };
            content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));

            Label eyebrow = new Label
            {
                AutoSize = true,
                Text = "一步完成安装",
                ForeColor = Accent,
                Font = new Font("Segoe UI Semibold", 10F, FontStyle.Bold),
                Margin = new Padding(0, 0, 0, 4)
            };
            Label heading = new Label
            {
                AutoSize = true,
                Text = "快速安装",
                ForeColor = Ink,
                Font = new Font("Segoe UI Semibold", 22F, FontStyle.Bold),
                Margin = new Padding(0, 0, 0, 8)
            };
            Label intro = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(600, 0),
                Text = "安装默认的 AE 效果复制组件。需要字幕识别时勾选 STT，确认后会把推荐模型下载到指定文件夹。模型检测、Python、运行时细项都可以在自定义安装中设置。",
                ForeColor = Color.FromArgb(87, 91, 97),
                Margin = new Padding(0, 0, 0, 22)
            };
            content.Controls.Add(eyebrow);
            content.Controls.Add(heading);
            content.Controls.Add(intro);

            GroupBox hostGroup = new GroupBox
            {
                Text = "安装到 Adobe 应用",
                AutoSize = true,
                Dock = DockStyle.Top,
                Padding = new Padding(14, 12, 14, 12),
                Margin = new Padding(0, 0, 0, 12),
                ForeColor = Ink
            };
            FlowLayoutPanel hostOptions = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = true,
                Margin = new Padding(0)
            };
            hostOptions.Controls.Add(_quickAfterEffects);
            hostOptions.Controls.Add(_quickPremiere);
            _chooseQuickAe = new Button { AutoSize = true, Text = "选择 AE 可执行文件", Margin = new Padding(0, 2, 8, 2) };
            _chooseQuickAe.Click += delegate { ChooseHostExecutable("AEFT"); };
            Button chooseQuickPr = new Button { AutoSize = true, Text = "选择 PR 可执行文件", Margin = new Padding(0, 2, 8, 2) };
            chooseQuickPr.Click += delegate { ChooseHostExecutable("PPRO"); };
            hostOptions.Controls.Add(_chooseQuickAe);
            hostOptions.Controls.Add(chooseQuickPr);
            Label hostHint = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(560, 0),
                Text = "安装器会自动查找 Adobe 2020（17.x）及以后版本；如果未找到，可直接点击上面的按钮选择 AfterFX.exe 或 Premiere Pro.exe。",
                ForeColor = Color.FromArgb(87, 91, 97),
                Margin = new Padding(0, 8, 0, 0)
            };
            TableLayoutPanel hostBody = new TableLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                ColumnCount = 1,
                RowCount = 2,
                Margin = new Padding(0)
            };
            hostBody.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            hostBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            hostBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            hostBody.Controls.Add(hostOptions, 0, 0);
            hostBody.Controls.Add(hostHint, 0, 1);
            hostGroup.Controls.Add(hostBody);
            content.Controls.Add(hostGroup);

            GroupBox sttGroup = new GroupBox
            {
                Text = "字幕识别（可选）",
                AutoSize = true,
                Dock = DockStyle.Top,
                Padding = new Padding(14, 12, 14, 12),
                Margin = new Padding(0, 0, 0, 12),
                ForeColor = Ink
            };
            Label sttHint = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(560, 0),
                Text = "勾选 STT 后默认安装 CPU whisper.cpp，并从零开始下载推荐 Whisper 模型；勾选 GPU 加速会额外安装 Vulkan GPU+CPU 运行时。",
                ForeColor = Color.FromArgb(87, 91, 97),
                Margin = new Padding(0, 0, 0, 6)
            };
            TableLayoutPanel sttBody = new TableLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                ColumnCount = 1,
                RowCount = 2,
                Margin = new Padding(0)
            };
            sttBody.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            sttBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            sttBody.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            sttBody.Controls.Add(sttHint, 0, 0);
            sttBody.Controls.Add(_quickModelPanel, 0, 1);
            sttGroup.Controls.Add(sttBody);
            content.Controls.Add(sttGroup);

            Panel included = new Panel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                BackColor = Color.White,
                Padding = new Padding(14, 12, 14, 12),
                Margin = new Padding(0, 0, 0, 18)
            };
            Label includedText = new Label
            {
                AutoSize = true,
                MaximumSize = new Size(560, 0),
                Text = "AE 效果复制组件会随 AE 一起安装且不可取消；选择 PR 时会自动要求 STT。",
                ForeColor = Color.FromArgb(58, 63, 70)
            };
            included.Controls.Add(includedText);
            content.Controls.Add(included);

            FlowLayoutPanel navigation = new FlowLayoutPanel
            {
                AutoSize = true,
                Dock = DockStyle.Top,
                FlowDirection = FlowDirection.LeftToRight,
                WrapContents = false,
                Margin = new Padding(0)
            };
            _customInstallButton = CreateNavigationButton("自定义安装…");
            _customInstallButton.Font = new Font(Font, FontStyle.Underline);
            _customInstallButton.Click += delegate { _customInstall.Checked = true; };
            navigation.Controls.Add(_customInstallButton);
            content.Controls.Add(navigation);

            page.Controls.Add(content);
            return page;
        }

        private void ChooseHostExecutable(string hostCode)
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = hostCode == "AEFT" ? "选择 After Effects 2020+ 的 AfterFX.exe" : "选择 Premiere Pro 2020+ 的 Adobe Premiere Pro.exe";
                dialog.Filter = "Adobe 可执行文件 (*.exe)|*.exe|所有文件 (*.*)|*.*";
                dialog.CheckFileExists = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string fileName = Path.GetFileName(dialog.FileName);
                string expected = hostCode == "AEFT" ? "AfterFX.exe" : "Adobe Premiere Pro.exe";
                if (!string.Equals(fileName, expected, StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show("请选择文件 " + expected + "。", ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                FileVersionInfo version;
                try { version = FileVersionInfo.GetVersionInfo(dialog.FileName); }
                catch (Exception exception)
                {
                    MessageBox.Show("无法读取 Adobe 版本：" + exception.Message, ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                int major = version.ProductMajorPart != 0 ? version.ProductMajorPart : version.FileMajorPart;
                int minor = version.ProductMinorPart != 0 ? version.ProductMinorPart : version.FileMinorPart;
                if (!ProductInfo.IsSupportedHostVersion(major, minor))
                {
                    MessageBox.Show("所选文件版本为 " + version.ProductVersion + "，需要 " + ProductInfo.SupportedHostLabel + "。", ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                if (hostCode == "AEFT") _aeExecutablePath = dialog.FileName;
                else _prExecutablePath = dialog.FileName;
                UpdateSelectedHostPaths();
                RefreshInspection();
            }
        }

        private void ChooseModel()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "选择本地 Whisper 模型";
                dialog.Filter = "Whisper 模型 (*.gguf;*.bin;*.pt)|*.gguf;*.bin;*.pt|所有文件 (*.*)|*.*";
                dialog.CheckFileExists = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                _modelPath = dialog.FileName;
                RefreshInspection();
            }
        }

        private void ChooseModelDirectory()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "\u9009\u62E9 CTranslate2 \u6216 Hugging Face Whisper \u6A21\u578B\u76EE\u5F55";
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                _modelPath = dialog.SelectedPath;
                RefreshInspection();
            }
        }

        private void ChooseQuickModelFolder()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择快速安装下载的 Whisper 模型保存文件夹";
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                _modelDestinationFolder = dialog.SelectedPath;
                _quickModelFolderLabel.Text = _modelDestinationFolder;
                UpdateActionState();
            }
        }

        private void SyncQuickHostSelection()
        {
            if (_quickAfterEffects == null || _quickPremiere == null || _syncingQuickHosts) return;
            _syncingQuickHosts = true;
            _quickAfterEffects.Checked = _installAfterEffects.Checked;
            _quickPremiere.Checked = _installPremiere.Checked;
            _syncingQuickHosts = false;
        }

        private void EnsureDefaultQuickModelFolder()
        {
            if (!string.IsNullOrWhiteSpace(_modelDestinationFolder)) return;
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrWhiteSpace(localAppData)) return;
            _modelDestinationFolder = Path.Combine(localAppData, "LocalWhisperSubtitles", "models");
            _quickModelFolderLabel.Text = _modelDestinationFolder;
        }

        private void ChoosePythonExecutable()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "选择 Python 运行时中的 python.exe";
                dialog.Filter = "Python 运行时 (python.exe)|python.exe|可执行文件 (*.exe)|*.exe";
                dialog.CheckFileExists = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                if (!string.Equals(Path.GetFileName(dialog.FileName), "python.exe", StringComparison.OrdinalIgnoreCase))
                {
                    MessageBox.Show("请选择 Python 环境中的 python.exe。", ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                _pythonExecutablePath = dialog.FileName;
                _selectedPythonPath.Text = _pythonExecutablePath;
                RefreshInspection();
            }
        }

        private void UpdateSelectedHostPaths()
        {
            StringBuilder text = new StringBuilder();
            if (!string.IsNullOrWhiteSpace(_aeExecutablePath)) text.Append("AE: ").Append(_aeExecutablePath);
            if (!string.IsNullOrWhiteSpace(_prExecutablePath))
            {
                if (text.Length > 0) text.Append("\r\n");
                text.Append("PR: ").Append(_prExecutablePath);
            }
            _selectedHostPaths.Text = text.Length > 0 ? text.ToString() : "未指定；安装器将自动探测标准路径";
        }

        private void RefreshInspection()
        {
            try
            {
                List<string> explicitPaths = new List<string>();
                if (!string.IsNullOrWhiteSpace(_aeExecutablePath)) explicitPaths.Add(_aeExecutablePath);
                if (!string.IsNullOrWhiteSpace(_prExecutablePath)) explicitPaths.Add(_prExecutablePath);
                _inspection = _engine.Inspect(explicitPaths.ToArray(), _quickInstall.Checked ? null : _modelPath, _pythonExecutablePath, !_quickInstall.Checked);
                StringBuilder hosts = new StringBuilder();
                bool hasSupported = false;
                for (int i = 0; i < _inspection.Hosts.Count; i++)
                {
                    HostInstallation host = _inspection.Hosts[i];
                    if (i > 0) hosts.Append("  ·  ");
                    hosts.Append(host.DisplayName).Append(": ");
                    hosts.Append(host.Supported ? "2020+ 可用" : host.Status);
                    if (host.Supported) hasSupported = true;
                }
                SetStatus(_hostStatus, hosts.ToString(), hasSupported ? Success : Warning);

                if (_inspection.Catalog == null)
                    SetStatus(_resourceStatus, "不可用：" + _inspection.Error, Accent);
                else if (_inspection.CpuRuntime != null && _inspection.CpuRuntime.IsValid)
                    SetStatus(_resourceStatus, "manifest 与 CPU 包 SHA-256 校验通过", Success);
                else
                    SetStatus(_resourceStatus, "CPU 包不可用：" + (_inspection.CpuRuntime == null ? "未声明" : _inspection.CpuRuntime.Error), Accent);

                if (!string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath))
                {
                    SetStatus(_runtimeStatus, "已安装 CPU 运行时（whisper.cpp）：" + _inspection.ExistingRuntimePath, Success);
                    _installCpu.Checked = false;
                }
                else
                {
                    SetStatus(_runtimeStatus, _customInstall.Checked
                        ? "未检测到 CPU runtime；自定义安装不会安装，请自行准备 CPU whisper.cpp。"
                        : "未安装 CPU runtime；快速安装会按 STT 需求自动准备。", Warning);
                }

                if (!string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath))
                {
                    SetStatus(_gpuStatus, "已安装 Vulkan GPU+CPU 运行时：" + _inspection.ExistingVulkanRuntimePath, Success);
                    _installVulkan.Checked = false;
                }
                else if (_inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid)
                    SetStatus(_gpuStatus, _customInstall.Checked
                        ? "未检测到现有 Vulkan runtime；自定义安装不会安装，请自行准备 Vulkan 或 CUDA/PyTorch。"
                        : "可用 Vulkan GPU+CPU runtime；快速安装可按需准备（无需 CUDA/PyTorch）。", Warning);

                if (_inspection.GpuRuntime != null && _inspection.GpuRuntime.Available && string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath))
                    SetStatus(_gpuStatus, "已检测到 GPU 运行时：" + _inspection.GpuRuntime.Backend + " · " + _inspection.GpuRuntime.PythonPath, Success);
                else if (string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath) && (_inspection.VulkanRuntime == null || !_inspection.VulkanRuntime.IsValid))
                    SetStatus(_gpuStatus, _customInstall.Checked
                        ? (_inspection.GpuRuntime == null ? "未检测到现有 GPU/Python runtime；自定义安装不会安装，请自行准备。" : _inspection.GpuRuntime.Detail)
                        : (_inspection.GpuRuntime == null ? "未检测到 GPU runtime；可跳过并只使用 CPU。" : _inspection.GpuRuntime.Detail), Warning);

                ModelScanResult modelScan = _inspection.ModelScan;
                if (_quickInstall.Checked)
                {
                    SetStatus(_modelStatus, "快速安装从零开始；勾选 STT 后只下载推荐模型，不扫描本地模型", Warning);
                }
                else if (modelScan != null && modelScan.Models.Count > 0)
                {
                    bool cpuRuntimeReady = !string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath) ||
                        (_inspection.CpuRuntime != null && _inspection.CpuRuntime.IsValid);
                    bool vulkanRuntimeReady = !string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath) ||
                        (_inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid);
                    int compatibleCount = CountCompatibleModels(modelScan.Models, _inspection.GpuRuntime, cpuRuntimeReady, vulkanRuntimeReady);
                    if (compatibleCount > 0)
                        SetStatus(_modelStatus, "找到 " + modelScan.Models.Count + " 个模型；" + compatibleCount + " 个已有可用运行环境", Success);
                    else
                        SetStatus(_modelStatus, "找到 " + modelScan.Models.Count + " 个模型，但当前资源无法直接运行其格式", Warning);
                }
                else if (_inspection.RecommendedModel != null && _inspection.RecommendedModel.IsValid)
                    SetStatus(_modelStatus, "资源包中已有推荐模型（安装器仍不会自动选用）", Success);
                else
                    SetStatus(_modelStatus, _customInstall.Checked
                        ? "未发现可用本地模型；自定义安装不会下载，请指定 Whisper 模型文件或目录。"
                        : "未发现模型；快速安装会在确认后下载推荐模型。", Warning);

                _uninstallButton.Visible = _engine.IsInstalled();
                if (_uninstallMode)
                {
                    _installCpu.Enabled = false;
                    _acceptLicense.Enabled = false;
                }
                UpdateActionState();
                UpdateInstallMode();
                _log.Text = "检测完成。安装范围仅限当前 Windows 用户。";
            }
            catch (Exception exception)
            {
                _log.Text = exception.Message;
                _primaryButton.Enabled = false;
            }
        }

        private void UpdateActionState()
        {
            if (_uninstallMode)
            {
                _primaryButton.Enabled = _engine.IsInstalled();
                return;
            }
            if (_inspection == null) { _primaryButton.Enabled = false; return; }
            bool hasAe = HasSupportedHost("AEFT");
            bool hasPr = HasSupportedHost("PPRO");
            bool selectedAe = _installAfterEffects.Checked;
            bool selectedPr = _installPremiere.Checked;
            bool hasHost = selectedAe && hasAe || selectedPr && hasPr;
            bool resourceReady = _inspection.Catalog != null;
            SyncQuickSttRequirement();
            bool quickMode = _quickInstall.Checked;
            bool sttRequested = selectedPr || (quickMode && _quickNeedStt.Checked);
            bool quickCpuReady = quickMode && SyncQuickRuntimeSelection(sttRequested);
            bool quickGpuRequested = _quickInstall.Checked && sttRequested && _quickGpuAcceleration != null && _quickGpuAcceleration.Checked;
            bool quickGpuReady = !quickGpuRequested
                || !string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath)
                || (_installVulkan.Checked && _inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid);
            bool existingRuntimeReady = !string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath)
                || !string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath)
                || (_inspection.GpuRuntime != null && _inspection.GpuRuntime.Available);
            bool customRuntimeReady = !sttRequested || existingRuntimeReady;
            bool runtimeReady = quickMode ? quickCpuReady && quickGpuReady : customRuntimeReady;
            bool modelReady = quickMode
                ? !sttRequested || !string.IsNullOrWhiteSpace(_modelDestinationFolder)
                : !selectedPr || IsSelectedModelReady();
            SyncEffectCopyRequirement();
            _installCpu.Enabled = false;
            _installVulkan.Enabled = false;
            _acceptLicense.Enabled = false;
            _primaryButton.Enabled = hasHost && resourceReady && runtimeReady && modelReady;
        }

        private bool IsSelectedModelReady()
        {
            if (string.IsNullOrWhiteSpace(_modelPath) || _inspection == null || _inspection.ModelScan == null)
                return false;
            string selectedFullPath;
            try
            {
                if (!File.Exists(_modelPath) && !Directory.Exists(_modelPath)) return false;
                selectedFullPath = Path.GetFullPath(_modelPath);
            }
            catch { return false; }
            bool cpuReady = !string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath);
            bool vulkanReady = !string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath);
            for (int i = 0; i < _inspection.ModelScan.Models.Count; i++)
            {
                ModelCandidate model = _inspection.ModelScan.Models[i];
                if (!string.Equals(model.Path, selectedFullPath, StringComparison.OrdinalIgnoreCase)) continue;
                bool compatible = (cpuReady || vulkanReady) && (model.Format == "ggml-bin" || model.Format == "gguf");
                if (_inspection.GpuRuntime != null)
                {
                    compatible = compatible || model.Format == "openai-pt" && _inspection.GpuRuntime.OpenAiWhisper && _inspection.GpuRuntime.TorchCuda;
                    compatible = compatible || model.Format == "ctranslate2" && _inspection.GpuRuntime.FasterWhisper && _inspection.GpuRuntime.CTranslate2Cuda;
                    compatible = compatible || model.Format == "huggingface-whisper" && _inspection.GpuRuntime.TransformersWhisper && _inspection.GpuRuntime.TorchCuda;
                }
                return compatible;
            }
            return false;
        }

        private bool HasSupportedHost(string hostCode)
        {
            for (int i = 0; i < _inspection.Hosts.Count; i++)
                if (string.Equals(_inspection.Hosts[i].HostCode, hostCode, StringComparison.OrdinalIgnoreCase)) return _inspection.Hosts[i].Supported;
            return false;
        }

        private void UpdateInstallMode()
        {
            if (_uninstallMode) return;
            bool custom = _customInstall.Checked;
            bool modeChanged = custom != _lastCustomMode;
            _lastCustomMode = custom;
            if (_customPage != null) _customPage.Visible = custom;
            if (_quickPage != null)
            {
                _quickPage.Visible = !custom;
                if (!custom) _quickPage.BringToFront();
            }
            SyncEffectCopyRequirement();
            bool quickStt = !custom && (_installPremiere.Checked || _quickNeedStt.Checked);
            // Custom installation is bring-your-own-resource. Runtime and
            // license controls are intentionally hidden in every mode; quick
            // mode drives their internal state automatically.
            _installCpu.Visible = false;
            _installVulkan.Visible = false;
            _acceptLicense.Visible = false;
            _installCpu.Enabled = false;
            _installVulkan.Enabled = false;
            _acceptLicense.Enabled = false;
            // Quick mode is intentionally conservative: it never exposes Python,
            // model and host path details as required install choices, but still
            // allows selecting AE/PR and the CPU/Vulkan STT components.
            _selectedPythonPath.Enabled = custom;
            _selectedHostPaths.Enabled = true;
            _modelPathPanel.Visible = custom;
            _pythonPathPanel.Visible = custom;
            _quickModelPanel.Visible = !custom;
            if (_customInstallButton != null) _customInstallButton.Enabled = !custom && !_busy;
            if (_backToQuickButton != null) _backToQuickButton.Enabled = custom && !_busy;
            if (_quickGpuAcceleration != null) _quickGpuAcceleration.Enabled = !custom && quickStt && !_busy;
            if (_chooseQuickAe != null) _chooseQuickAe.Enabled = !custom && !_busy;
            if (modeChanged && _inspection != null)
            {
                RefreshInspection();
                return;
            }
            UpdateActionState();
        }

        private void SyncQuickSttRequirement()
        {
            if (_quickNeedStt == null) return;
            bool required = _quickInstall.Checked && _installPremiere.Checked;
            if (required) _quickNeedStt.Checked = true;
            _quickNeedStt.Enabled = !required;
            _chooseQuickModelFolder.Enabled = _quickNeedStt.Checked;
            if (_quickCpuRuntimeLabel != null)
            {
                bool existingCpu = _inspection != null && !string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath);
                _quickCpuRuntimeLabel.Text = !_quickNeedStt.Checked
                    ? "CPU 计算：未启用（勾选 STT 后自动安装）"
                    : existingCpu
                        ? "CPU 计算：检测到现有 CPU whisper.cpp，将直接复用"
                        : "CPU 计算：安装 CPU whisper.cpp 运行时（STT 必需）";
            }
            if (_quickGpuAcceleration != null)
            {
                bool vulkanAvailable = _inspection != null
                    && (!string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath)
                        || _inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid);
                _quickGpuAcceleration.Enabled = _quickInstall.Checked && _quickNeedStt.Checked && vulkanAvailable && !_busy;
                if (!_quickGpuAcceleration.Enabled && _quickGpuAcceleration.Checked)
                {
                    _syncingQuickRuntime = true;
                    _quickGpuAcceleration.Checked = false;
                    _installVulkan.Checked = false;
                    _syncingQuickRuntime = false;
                }
            }
        }

        private bool SyncQuickRuntimeSelection(bool sttRequested)
        {
            if (!_quickInstall.Checked || !sttRequested || _inspection == null) return !sttRequested;
            bool hasExistingCpu = !string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath);
            bool canInstallCpu = _inspection.CpuRuntime != null && _inspection.CpuRuntime.IsValid;
            bool hasExistingVulkan = !string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath);
            bool canInstallVulkan = _inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid;
            bool gpuRequested = _quickGpuAcceleration != null && _quickGpuAcceleration.Checked;
            _syncingQuickRuntime = true;
            if (hasExistingCpu)
                _installCpu.Checked = false;
            else if (canInstallCpu)
                _installCpu.Checked = true;
            if (gpuRequested && hasExistingVulkan)
                _installVulkan.Checked = false;
            else if (gpuRequested && canInstallVulkan)
                _installVulkan.Checked = true;
            else if (!gpuRequested)
                _installVulkan.Checked = false;
            _syncingQuickRuntime = false;
            bool cpuReady = hasExistingCpu || (_installCpu.Checked && canInstallCpu);
            if (gpuRequested)
            {
                bool gpuReady = hasExistingVulkan || (_installVulkan.Checked && canInstallVulkan);
                return cpuReady && gpuReady;
            }
            return cpuReady;
        }

        private static string FormatBytes(long value)
        {
            if (value >= 1024L * 1024L * 1024L) return (value / 1073741824.0).ToString("0.0") + " GB";
            return (value / 1048576.0).ToString("0") + " MB";
        }

        private void SyncEffectCopyRequirement()
        {
            bool required = _installAfterEffects != null && _installAfterEffects.Checked;
            if (_installEffectCopy != null)
            {
                _installEffectCopy.Checked = required;
                _installEffectCopy.Enabled = false;
            }
        }

        private static int CountCompatibleModels(List<ModelCandidate> models, GpuRuntimeStatus gpu, bool cpuRuntimeReady, bool vulkanRuntimeReady)
        {
            int count = 0;
            for (int i = 0; i < models.Count; i++)
            {
                string format = models[i].Format ?? string.Empty;
                bool compatible = (cpuRuntimeReady || vulkanRuntimeReady) && (format == "ggml-bin" || format == "gguf");
                if (gpu != null)
                {
                    compatible = compatible || format == "openai-pt" && gpu.OpenAiWhisper && gpu.TorchCuda;
                    compatible = compatible || format == "ctranslate2" && gpu.FasterWhisper && gpu.CTranslate2Cuda;
                    compatible = compatible || format == "huggingface-whisper" && gpu.TransformersWhisper && gpu.TorchCuda;
                }
                if (compatible) count++;
            }
            return count;
        }

        private void BeginInstall()
        {
            bool quickStt = _quickInstall.Checked && (_installPremiere.Checked || _quickNeedStt.Checked);
            bool quickInstallCpu = quickStt && _installCpu.Checked
                && _inspection != null
                && string.IsNullOrWhiteSpace(_inspection.ExistingRuntimePath)
                && _inspection.CpuRuntime != null && _inspection.CpuRuntime.IsValid;
            bool quickInstallVulkan = quickStt && _quickGpuAcceleration != null && _quickGpuAcceleration.Checked
                && _installVulkan.Checked
                && _inspection != null
                && string.IsNullOrWhiteSpace(_inspection.ExistingVulkanRuntimePath)
                && _inspection.VulkanRuntime != null && _inspection.VulkanRuntime.IsValid;
            bool downloadRecommendedModel = quickStt;
            bool quickLicenseAccepted = _acceptLicense.Checked;
            if (downloadRecommendedModel || quickInstallCpu || quickInstallVulkan)
            {
                StringBuilder confirmation = new StringBuilder();
                ResourcePackage recommended = _inspection != null && _inspection.Catalog != null ? _inspection.Catalog.FindRecommendedModel() : null;
                string modelName = recommended == null ? "推荐 Whisper 模型" : recommended.displayName;
                string size = recommended == null || recommended.size <= 0 ? "" : "（约 " + FormatBytes(recommended.size) + "）";
                if (downloadRecommendedModel) confirmation.Append("将下载 ").Append(modelName).Append(size).Append(" 到：\r\n").Append(_modelDestinationFolder);
                if (quickInstallCpu) confirmation.Append("\r\n\r\n同时安装 CPU whisper.cpp 运行时（无需 CUDA/PyTorch）。");
                if (quickInstallVulkan) confirmation.Append("\r\n\r\n同时安装 Vulkan GPU+CPU 运行时（无需 CUDA/PyTorch）。");
                confirmation.Append("\r\n\r\n继续安装吗？");
                DialogResult answer = MessageBox.Show(
                    confirmation.ToString(),
                    ProductInfo.Name,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question);
                if (answer != DialogResult.Yes) return;
                if (quickInstallCpu || quickInstallVulkan) quickLicenseAccepted = true;
            }
            InstallOptions options = new InstallOptions
            {
                QuickInstall = _quickInstall.Checked,
                InstallAfterEffects = _installAfterEffects.Checked,
                InstallPremiere = _installPremiere.Checked,
                InstallEffectCopy = _installAfterEffects.Checked,
                InstallCpuRuntime = _quickInstall.Checked && quickStt && _installCpu.Checked,
                InstallVulkanRuntime = _quickInstall.Checked && quickStt && _installVulkan.Checked,
                DownloadRecommendedModel = downloadRecommendedModel,
                LicenseAccepted = _quickInstall.Checked ? quickLicenseAccepted : false,
                HostExecutablePaths = new string[] { _aeExecutablePath, _prExecutablePath },
                PythonExecutablePath = _pythonExecutablePath,
                ModelPath = _quickInstall.Checked ? null : _modelPath,
                ModelDestinationFolder = _modelDestinationFolder
            };
            RunOperation(delegate { _engine.Install(options, ReportThreadSafe); }, "安装完成。请重启 Adobe 应用后打开“窗口 > 扩展”中的面板。");
        }

        private void BeginUninstall()
        {
            DialogResult answer = MessageBox.Show(
                "将移除 CEP 扩展和本插件管理的运行时。外部 Whisper 模型、用户设置和共享的 CEP 调试开关会保留。继续吗？",
                ProductInfo.Name,
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);
            if (answer != DialogResult.Yes) return;
            RunOperation(delegate { _engine.Uninstall(ReportThreadSafe); }, "卸载完成。外部模型未被删除。");
        }

        private void RunOperation(DoWorkEventHandler operation, string successMessage)
        {
            SetBusy(true);
            BackgroundWorker worker = new BackgroundWorker();
            worker.DoWork += operation;
            worker.RunWorkerCompleted += delegate(object sender, RunWorkerCompletedEventArgs eventArgs)
            {
                SetBusy(false);
                if (eventArgs.Error != null)
                {
                    _log.Text = eventArgs.Error.Message;
                    MessageBox.Show(eventArgs.Error.Message, ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
                }
                else
                {
                    _log.Text = successMessage;
                    MessageBox.Show(successMessage, ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
                    RefreshInspection();
                }
            };
            worker.RunWorkerAsync();
        }

        private void SetBusy(bool busy)
        {
            _busy = busy;
            _primaryButton.Enabled = !busy;
            _uninstallButton.Enabled = !busy;
            _closeButton.Enabled = !busy;
            _installCpu.Enabled = false;
            _installVulkan.Enabled = false;
            _installAfterEffects.Enabled = !busy;
            _installPremiere.Enabled = !busy;
            _installEffectCopy.Enabled = false;
            _quickInstall.Enabled = !busy;
            _customInstall.Enabled = !busy;
            if (_customInstallButton != null) _customInstallButton.Enabled = !busy && _quickInstall.Checked;
            if (_backToQuickButton != null) _backToQuickButton.Enabled = !busy && _customInstall.Checked;
            if (_quickAfterEffects != null) _quickAfterEffects.Enabled = !busy;
            if (_quickPremiere != null) _quickPremiere.Enabled = !busy;
            if (_quickGpuAcceleration != null) _quickGpuAcceleration.Enabled = !busy && _quickInstall.Checked && _quickNeedStt.Checked;
            if (_chooseQuickAe != null) _chooseQuickAe.Enabled = !busy && _quickInstall.Checked;
            _quickNeedStt.Enabled = !busy && !(_quickInstall.Checked && _installPremiere.Checked);
            _chooseQuickModelFolder.Enabled = !busy && _quickNeedStt.Checked;
            SyncQuickSttRequirement();
            _acceptLicense.Enabled = false;
            _progress.Style = busy ? ProgressBarStyle.Marquee : ProgressBarStyle.Blocks;
            ControlBox = !busy;
        }

        private void ReportThreadSafe(string message)
        {
            if (InvokeRequired)
            {
                BeginInvoke(new Action<string>(ReportThreadSafe), message);
                return;
            }
            _log.Text = message;
        }

        private void OpenRuntimeLicense()
        {
            try
            {
                if (_inspection == null || _inspection.Catalog == null) throw new FileNotFoundException("资源清单不可用。");
                ResourcePackage runtime = _inspection.Catalog.FindCpuRuntime();
                if (runtime == null || runtime.licenseIds == null || runtime.licenseIds.Count == 0) throw new FileNotFoundException("运行时许可证未声明。");
                for (int i = 0; i < _inspection.Catalog.Manifest.licenses.Count; i++)
                {
                    ResourceLicense license = _inspection.Catalog.Manifest.licenses[i];
                    if (!runtime.licenseIds.Contains(license.id)) continue;
                    string path = _inspection.Catalog.ResolveLicense(license);
                    if (path == null) throw new FileNotFoundException("许可证文件不存在。");
                    Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
                    return;
                }
                throw new FileNotFoundException("运行时许可证未找到。");
            }
            catch (Exception exception)
            {
                MessageBox.Show(exception.Message, ProductInfo.Name, MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static void SetStatus(Label label, string text, Color color)
        {
            label.Text = text;
            label.ForeColor = color;
        }
    }
}
