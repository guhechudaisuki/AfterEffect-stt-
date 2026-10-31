Unicode true
ManifestDPIAware true
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 16
!include "MUI2.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "Local Whisper Subtitles ${PRODUCT_VERSION}"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\LocalWhisperSubtitles"
BrandingText "Local Whisper Subtitles · AE / PR 2020+"
SetFont "Microsoft YaHei UI" 9
VIProductVersion "${PRODUCT_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "Local Whisper Subtitles"
VIAddVersionKey /LANG=2052 "FileDescription" "Local Whisper Subtitles NSIS 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "Local Whisper Subtitles contributors"
!define MUI_ABORTWARNING
!define MUI_CUSTOMFUNCTION_ABORT CheckDetectionAbort
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install-blue.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall-blue.ico"
!define MUI_FINISHPAGE_NOAUTOCLOSE
!define MUI_LICENSEPAGE_CHECKBOX
Page custom QuickPage QuickLeave
Page custom CustomPage CustomLeave
!define MUI_PAGE_CUSTOMFUNCTION_PRE LicensePre
!define MUI_PAGE_CUSTOMFUNCTION_LEAVE LicenseLeave
!insertmacro MUI_PAGE_LICENSE "${LICENSE_FILE}"
Page custom ReviewPage
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

Var Mode
Var Ae
Var Pr
Var Stt
Var Gpu
Var ModelFolder
Var ModelPath
Var PythonPath
Var ToolFolder
Var AePath
Var PrPath
Var Consent
Var FullScan
Var Request
Var Report
Var Dialog
Var AeBox
Var PrBox
Var SttBox
Var GpuBox
Var FolderEdit
Var ModelCombo
Var PythonEdit
Var ToolsEdit
Var StatusEdit
Var RefreshButton
Var ScanButton
Var CustomBusy
Var Changed
Var InspectionStarted

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "此安装包需要 Windows x64。"
    Abort
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=InstallBackend.exe "${BACKEND_FILE}"
  StrCpy $Request "$PLUGINSDIR\options.ini"
  StrCpy $Report "$PLUGINSDIR\inspection.ini"
  StrCpy $Mode "quick"
  StrCpy $Ae 1
  StrCpy $Pr 0
  StrCpy $Stt 0
  StrCpy $Gpu 0
  StrCpy $Consent 0
  StrCpy $FullScan 0
  StrCpy $CustomBusy 0
  StrCpy $Changed 1
  StrCpy $ModelFolder "$LOCALAPPDATA\LocalWhisperSubtitles\models"
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--self-test" $1
  ${IfNot} ${Errors}
    SetSilent silent
    nsExec::ExecToStack /TIMEOUT=30000 '"$PLUGINSDIR\InstallBackend.exe" --self-test --resources-root "$EXEDIR\resources"'
    Pop $0
    Pop $1
    SetErrorLevel $0
    Quit
  ${EndIf}
  ${If} ${Silent}
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function CheckDetectionAbort
  ${If} $CustomBusy == 1
    MessageBox MB_ICONINFORMATION "正在只读检测本地环境，请等待检测完成后关闭。"
    Abort
  ${EndIf}
FunctionEnd

Function SaveOptions
  ; Use Unicode INI even on non-Chinese Windows locales.
  FileOpen $9 $Request w
  FileWriteWord $9 65279
  FileWriteUTF16LE $9 "; Local Whisper Subtitles$\r$\n"
  FileClose $9
  WriteINIStr $Request "options" "quick" "1"
  ${If} $Mode == "custom"
    WriteINIStr $Request "options" "quick" "0"
  ${EndIf}
  WriteINIStr $Request "options" "ae" $Ae
  WriteINIStr $Request "options" "pr" $Pr
  WriteINIStr $Request "options" "stt" $Stt
  WriteINIStr $Request "options" "gpu" $Gpu
  WriteINIStr $Request "options" "license" $Consent
  WriteINIStr $Request "options" "modelFolder" $ModelFolder
  WriteINIStr $Request "options" "modelPath" $ModelPath
  WriteINIStr $Request "options" "pythonPath" $PythonPath
  WriteINIStr $Request "options" "toolFolder" $ToolFolder
  WriteINIStr $Request "options" "aePath" $AePath
  WriteINIStr $Request "options" "prPath" $PrPath
  WriteINIStr $Request "options" "fullScan" $FullScan
  WriteINIStr $Request "options" "uninstaller" "$PLUGINSDIR\Uninstall.exe"
FunctionEnd

Function Inspect
  Call SaveOptions
  Delete $Report
  nsExec::ExecToStack /TIMEOUT=180000 '"$PLUGINSDIR\InstallBackend.exe" --inspect-cli --request "$Request" --report "$Report" --resources-root "$EXEDIR\resources"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    ReadINIStr $1 $Report "result" "error"
    MessageBox MB_ICONEXCLAMATION "本地检测没有完成：$1$\r$\n请检查资源包是否与 Setup.exe 放在同一目录。"
  ${EndIf}
FunctionEnd

Function QuickPage
  StrCpy $Mode "quick"
  !insertmacro MUI_HEADER_TEXT "快速安装" "选择 AE / PR；默认只安装 AE 特效复制。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateCheckbox} 0 0 100% 14u "After Effects（含必装的特效复制）"
  Pop $AeBox
  ${NSD_SetState} $AeBox $Ae
  ${NSD_OnClick} $AeBox HostChanged
  ${NSD_CreateCheckbox} 0 21u 100% 14u "Premiere Pro（必须启用 STT）"
  Pop $PrBox
  ${NSD_SetState} $PrBox $Pr
  ${NSD_OnClick} $PrBox HostChanged
  ${NSD_CreateCheckbox} 0 47u 100% 14u "安装字幕识别 STT（默认 CPU，自动下载推荐模型）"
  Pop $SttBox
  ${NSD_SetState} $SttBox $Stt
  ${NSD_OnClick} $SttBox HostChanged
  ${NSD_CreateCheckbox} 12u 66u 287u 14u "GPU 加速（Vulkan GPU+CPU，无需 CUDA / PyTorch）"
  Pop $GpuBox
  ${NSD_SetState} $GpuBox $Gpu
  ${NSD_OnClick} $GpuBox HostChanged
  ${NSD_CreateLabel} 0 88u 100% 11u "STT 下载目录（不会扫描本地模型）"
  Pop $0
  ${NSD_CreateDirRequest} 0 101u 244u 13u $ModelFolder
  Pop $FolderEdit
  ${NSD_CreateBrowseButton} 249u 100u 50u 15u "浏览…"
  Pop $0
  ${NSD_OnClick} $0 ChooseDownloadFolder
  ${NSD_CreateLink} 0 126u 180u 12u "自定义安装…（使用已有模型与环境）"
  Pop $0
  ${NSD_OnClick} $0 OpenCustom
  Call SyncQuick
  nsDialogs::Show
FunctionEnd

Function HostChanged
  Pop $0
  ${NSD_GetState} $AeBox $Ae
  ${NSD_GetState} $PrBox $Pr
  ${NSD_GetState} $SttBox $Stt
  ${NSD_GetState} $GpuBox $Gpu
  Call SyncQuick
FunctionEnd

Function SyncQuick
  ${If} $Pr == 1
    StrCpy $Stt 1
    ${NSD_SetState} $SttBox 1
    EnableWindow $SttBox 0
  ${Else}
    EnableWindow $SttBox 1
  ${EndIf}
  EnableWindow $GpuBox $Stt
  EnableWindow $FolderEdit $Stt
FunctionEnd

Function ChooseDownloadFolder
  Pop $0
  nsDialogs::SelectFolderDialog "选择模型下载目录" $ModelFolder
  Pop $0
  ${If} $0 != "error"
    StrCpy $ModelFolder $0
    ${NSD_SetText} $FolderEdit $ModelFolder
  ${EndIf}
FunctionEnd

Function OpenCustom
  Pop $0
  ${NSD_GetText} $FolderEdit $ModelFolder
  StrCpy $Mode "custom"
  StrCpy $Changed 1
  ; Queue navigation after the nsDialogs callback returns; synchronous BM_CLICK
  ; would reenter the NSIS VM and freeze the installer window.
  System::Call 'user32::PostMessageW(p $HWNDPARENT, i ${WM_COMMAND}, p 1, p 0)'
FunctionEnd

Function CheckHosts
  ReadINIStr $0 $Report "result" "hostsReady"
  ${If} $0 == "1"
    Return
  ${EndIf}
  ${If} $Ae == 1
    ReadINIStr $0 $Report "hosts" "AEFT"
    ${If} $0 != "1"
      MessageBox MB_ICONINFORMATION "未自动找到可用的 AE 2020+。请选择 AfterFX.exe，不需要切换安装模式。"
      nsDialogs::SelectFileDialog open "" "AfterFX.exe|AfterFX.exe|可执行文件|*.exe"
      Pop $AePath
      StrCpy $Changed 1
    ${EndIf}
  ${EndIf}
  ${If} $Pr == 1
    ReadINIStr $0 $Report "hosts" "PPRO"
    ${If} $0 != "1"
      MessageBox MB_ICONINFORMATION "未自动找到可用的 PR 2020+。请选择 Adobe Premiere Pro.exe。"
      nsDialogs::SelectFileDialog open "" "Adobe Premiere Pro.exe|Adobe Premiere Pro.exe|可执行文件|*.exe"
      Pop $PrPath
      StrCpy $Changed 1
    ${EndIf}
  ${EndIf}
  Abort
FunctionEnd

Function QuickLeave
  ${NSD_GetText} $FolderEdit $ModelFolder
  ${If} $Ae != 1
  ${AndIf} $Pr != 1
    MessageBox MB_ICONEXCLAMATION "请至少选择 AE 或 PR。"
    StrCpy $Mode "quick"
    Abort
  ${EndIf}
  ${If} $Mode == "custom"
    Return
  ${EndIf}
  Call Inspect
  Call CheckHosts
  ReadINIStr $0 $Report "result" "ready"
  ${If} $0 != "1"
    ReadINIStr $1 $Report "resources" "error"
    MessageBox MB_ICONEXCLAMATION "安装资源未准备好：$1"
    Abort
  ${EndIf}
FunctionEnd

Function CustomPage
  ${If} $Mode != "custom"
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "自定义安装" "只接入已有资源，不下载模型、CPU/GPU 运行时或 CUDA/PyTorch。"
  nsDialogs::Create 1018
  Pop $Dialog
  ${NSD_CreateLabel} 0 1u 37u 12u "模型"
  Pop $0
  ${NSD_CreateComboBox} 38u 0 178u 100u ""
  Pop $ModelCombo
  ${NSD_SetText} $ModelCombo $ModelPath
  ${NSD_CreateButton} 220u 0 38u 14u "文件…"
  Pop $0
  ${NSD_OnClick} $0 ChooseModelFile
  ${NSD_CreateButton} 261u 0 38u 14u "目录…"
  Pop $0
  ${NSD_OnClick} $0 ChooseModelFolder
  ${NSD_CreateLabel} 0 24u 37u 12u "Python"
  Pop $0
  ${NSD_CreateFileRequest} 38u 22u 218u 14u $PythonPath
  Pop $PythonEdit
  ${NSD_CreateBrowseButton} 261u 22u 38u 14u "指定…"
  Pop $0
  ${NSD_OnClick} $0 ChoosePython
  ${NSD_CreateLabel} 0 47u 37u 12u "扫描目录"
  Pop $0
  ${NSD_CreateDirRequest} 38u 44u 218u 14u $ToolFolder
  Pop $ToolsEdit
  ${NSD_CreateBrowseButton} 261u 44u 38u 14u "选择…"
  Pop $0
  ${NSD_OnClick} $0 ChooseTools
  ${NSD_CreateButton} 0 66u 145u 16u "扫描指定目录 / 重新检测"
  Pop $RefreshButton
  ${NSD_OnClick} $RefreshButton RefreshLocal
  ${NSD_CreateButton} 153u 66u 146u 16u "全盘扫描（只读，可能较慢）"
  Pop $ScanButton
  ${NSD_OnClick} $ScanButton ScanAll
  nsDialogs::CreateControl "EDIT" ${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 89u 100% 50u "正在读取已保存的路径并检测本地环境…"
  Pop $StatusEdit
  ${If} $Changed == 1
    ${NSD_CreateTimer} AutoDetect 100
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function AutoDetect
  ${NSD_KillTimer} AutoDetect
  Call DetectLocal
FunctionEnd

Function DetectLocal
  ${If} $CustomBusy == 1
    Return
  ${EndIf}
  StrCpy $CustomBusy 1
  EnableWindow $RefreshButton 0
  EnableWindow $ScanButton 0
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 0
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 0
  ${NSD_SetText} $StatusEdit "正在检测：优先读取保存的路径，验证本地 Python 与模型格式。请稍候…"
  ${NSD_GetText} $ModelCombo $ModelPath
  ${NSD_GetText} $PythonEdit $PythonPath
  ${NSD_GetText} $ToolsEdit $ToolFolder
  ${If} $ToolFolder != ""
  ${AndIf} $ModelPath == ""
    StrCpy $ModelPath $ToolFolder
  ${EndIf}
  Call SaveOptions
  Delete $Report
  System::Call 'kernel32::GetTickCount() i .r0'
  StrCpy $InspectionStarted $0
  ClearErrors
  Exec '"$PLUGINSDIR\InstallBackend.exe" --inspect-cli --request "$Request" --report "$Report" --resources-root "$EXEDIR\resources"'
  ${If} ${Errors}
    ${NSD_SetText} $StatusEdit "无法启动本地检测，请重新解压安装包。"
    Call EndDetection
    Return
  ${EndIf}
  ${NSD_CreateTimer} PollInspection 250
FunctionEnd

Function PollInspection
  ReadINIStr $0 $Report "result" "error"
  ${If} $0 != ""
    ${NSD_SetText} $StatusEdit "检测未完成：$0"
    Call EndDetection
    Return
  ${EndIf}
  ReadINIStr $0 $Report "result" "success"
  ${If} $0 != "1"
    System::Call 'kernel32::GetTickCount() i .r0'
    IntOp $0 $0 - $InspectionStarted
    ${If} $0 > 180000
      ${NSD_SetText} $StatusEdit "检测达到时间限制，不能据此判定环境缺失。请缩小扫描目录后重试。"
      Call EndDetection
    ${EndIf}
    Return
  ${EndIf}
  ${NSD_KillTimer} PollInspection
  ReadINIStr $0 $Report "resources" "modelPath"
  ${If} $0 != ""
    StrCpy $ModelPath $0
  ${EndIf}
  SendMessage $ModelCombo ${CB_RESETCONTENT} 0 0
  ReadINIStr $1 $Report "resources" "modelCount"
  StrCpy $2 0
  ${DoWhile} $2 < $1
    ReadINIStr $0 $Report "model$2" "path"
    ${NSD_CB_AddString} $ModelCombo $0
    IntOp $2 $2 + 1
  ${Loop}
  ${NSD_SetText} $ModelCombo $ModelPath
  ReadINIStr $0 $Report "resources" "pythonPath"
  ${If} $0 != ""
    StrCpy $PythonPath $0
    ${NSD_SetText} $PythonEdit $PythonPath
  ${EndIf}
  ReadINIStr $0 $Report "resources" "modelStatus"
  ReadINIStr $1 $Report "resources" "cpuStatus"
  ReadINIStr $2 $Report "resources" "gpuStatus"
  ReadINIStr $3 $Report "resources" "ffmpegPath"
  ${NSD_SetText} $StatusEdit "$0$\r$\n$1$\r$\n$2$\r$\nFFmpeg：$3"
  StrCpy $FullScan 0
  StrCpy $Changed 0
  Call EndDetection
FunctionEnd

Function EndDetection
  ${NSD_KillTimer} PollInspection
  StrCpy $CustomBusy 0
  EnableWindow $RefreshButton 1
  EnableWindow $ScanButton 1
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  GetDlgItem $0 $HWNDPARENT 3
  EnableWindow $0 1
FunctionEnd

Function RefreshLocal
  Pop $0
  StrCpy $FullScan 0
  Call DetectLocal
FunctionEnd

Function ScanAll
  Pop $0
  StrCpy $FullScan 1
  Call DetectLocal
FunctionEnd

Function ChooseModelFile
  Pop $0
  nsDialogs::SelectFileDialog open "" "Whisper 模型|*.bin;*.gguf;*.pt|所有文件|*.*"
  Pop $0
  ${If} $0 != ""
    StrCpy $ModelPath $0
    ${NSD_SetText} $ModelCombo $ModelPath
    Call DetectLocal
  ${EndIf}
FunctionEnd

Function ChooseModelFolder
  Pop $0
  nsDialogs::SelectFolderDialog "选择 Whisper 模型目录" $ModelPath
  Pop $0
  ${If} $0 != "error"
    StrCpy $ModelPath $0
    ${NSD_SetText} $ModelCombo $ModelPath
    Call DetectLocal
  ${EndIf}
FunctionEnd

Function ChoosePython
  Pop $0
  nsDialogs::SelectFileDialog open "" "Python|python.exe|可执行文件|*.exe"
  Pop $0
  ${If} $0 != ""
    StrCpy $PythonPath $0
    ${NSD_SetText} $PythonEdit $PythonPath
    Call DetectLocal
  ${EndIf}
FunctionEnd

Function ChooseTools
  Pop $0
  nsDialogs::SelectFolderDialog "选择环境或模型所在的文件夹" $ToolFolder
  Pop $0
  ${If} $0 != "error"
    StrCpy $ToolFolder $0
    ${NSD_SetText} $ToolsEdit $ToolFolder
    StrCpy $ModelPath ""
    ${NSD_SetText} $ModelCombo ""
    Call DetectLocal
  ${EndIf}
FunctionEnd

Function CustomLeave
  ${If} $CustomBusy == 1
    Abort
  ${EndIf}
  ${NSD_GetText} $ModelCombo $ModelPath
  ${NSD_GetText} $PythonEdit $PythonPath
  ${NSD_GetText} $ToolsEdit $ToolFolder
  ; Revalidate the selected model, not just any unrelated available backend.
  Call Inspect
  Call CheckHosts
  ReadINIStr $0 $Report "result" "ready"
  ${If} $0 != "1"
    MessageBox MB_ICONEXCLAMATION "PR 需要模型与匹配的 CPU 或 GPU 环境。请指定模型 / 环境目录；AE 特效复制不需要 STT。"
    Abort
  ${EndIf}
FunctionEnd

Function LicensePre
  ${If} $Mode != "quick"
  ${OrIf} $Stt != 1
    Abort
  ${EndIf}
FunctionEnd
Function LicenseLeave
  StrCpy $Consent 1
FunctionEnd

Function ReviewPage
  !insertmacro MUI_HEADER_TEXT "确认安装" "仅安装当前 Windows 用户的插件；不会打开 AE / PR。"
  nsDialogs::Create 1018
  Pop $Dialog
  StrCpy $1 "快速安装"
  ${If} $Mode == "custom"
    StrCpy $1 "自定义安装"
  ${EndIf}
  StrCpy $0 "安装模式：$1$\r$\n"
  ${If} $Ae == 1
    StrCpy $0 "$0After Effects：安装（含特效复制）$\r$\n"
  ${EndIf}
  ${If} $Pr == 1
    StrCpy $0 "$0Premiere Pro：安装（含 STT）$\r$\n"
  ${EndIf}
  StrCpy $0 "$0$\r$\n"
  ${If} $Mode == "quick"
    ${If} $Stt == 1
      StrCpy $0 "$0将下载推荐 Whisper 模型并安装 CPU 运行时。$\r$\n下载目录：$ModelFolder"
      ${If} $Gpu == 1
        StrCpy $0 "$0$\r$\n安装 Vulkan GPU+CPU 加速（无需 CUDA/PyTorch）。"
      ${EndIf}
    ${Else}
      StrCpy $0 "$0只安装 AE 特效复制，不下载 STT 模型或计算运行时。"
    ${EndIf}
  ${Else}
    StrCpy $0 "$0使用已有模型：$ModelPath$\r$\nPython：$PythonPath$\r$\n不会下载模型或 CPU/GPU 运行时。"
  ${EndIf}
  nsDialogs::CreateControl "EDIT" ${WS_CHILD}|${WS_VISIBLE}|${WS_TABSTOP}|${WS_VSCROLL}|${ES_MULTILINE}|${ES_READONLY}|${ES_AUTOVSCROLL} ${WS_EX_CLIENTEDGE} 0 0 100% 130u $0
  Pop $0
  nsDialogs::Show
FunctionEnd

Section "安装"
  Call SaveOptions
  WriteUninstaller "$PLUGINSDIR\Uninstall.exe"
  DetailPrint "正在验证并安装所选组件…"
  nsExec::ExecToLog '"$PLUGINSDIR\InstallBackend.exe" --install-cli --request "$Request" --report "$PLUGINSDIR\install-result.ini" --resources-root "$EXEDIR\resources"'
  Pop $0
  ${If} $0 != 0
    ReadINIStr $1 "$PLUGINSDIR\install-result.ini" "result" "error"
    DetailPrint "安装未完成：$1"
    MessageBox MB_ICONSTOP "安装未完成，原安装已尝试回滚：$\r$\n$1"
    SetErrorLevel 1
    Abort
  ${EndIf}
SectionEnd

Section "Uninstall"
  InitPluginsDir
  CopyFiles /SILENT "$LOCALAPPDATA\LocalWhisperSubtitles\InstallBackend.exe" "$PLUGINSDIR\InstallBackend.exe"
  nsExec::ExecToLog '"$PLUGINSDIR\InstallBackend.exe" --uninstall-cli'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "卸载未完成。请关闭 AE / PR 后重试。"
    SetErrorLevel 1
    Abort
  ${EndIf}
  DetailPrint "已保留用户模型与 setting.txt。"
SectionEnd
