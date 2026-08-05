; 聚元灵创 Inno Setup Script (WinUI version)
; Pass /DDevBuild=1 to produce a side-by-side dev installer.
#ifdef DevBuild
  #define MyAppName "聚元灵创 (Dev)"
  #define MyAppAumid "Juyuan.Lingchuang.Dev"
  #define MyAppId "{{1EBE3D92-C054-4D04-9B35-569B3CF61E31}"
  #define MyInstallDir "JuyuanLingchuang-Dev"
  #define MyMutex "JuyuanLingchuang-Dev"
  #define MyAutoStartName "JuyuanLingchuang-Dev"
  #define MyStartupTaskName "聚元灵创 (Dev)"
  #define MyDistroName "JuyuanLingchuangGateway-Dev"
  #define MyProtocol "juyuanlingchuang-dev"
  #define MyOutputSuffix "-Dev"
#else
  #define MyAppName "聚元灵创"
  #define MyAppAumid "Juyuan.Lingchuang"
  #define MyAppId "{{7EF82E29-3929-41A4-ABCE-EF30314C0E8E}"
  #define MyInstallDir "JuyuanLingchuang"
  #define MyMutex "JuyuanLingchuang"
  #define MyAutoStartName "JuyuanLingchuang"
  #define MyStartupTaskName "聚元灵创"
  #define MyDistroName "JuyuanLingchuangGateway"
  #define MyProtocol "juyuanlingchuang"
  #define MyOutputSuffix ""
#endif
#define MyAppPublisher "聚元灵创"
#define MyAppURL "https://juyuanlingchuang.com"
#define MyAppExeName "JuyuanLingchuang.exe"

; MyAppArch should be passed via /DMyAppArch=x64 or /DMyAppArch=arm64
#ifndef MyAppArch
  #define MyAppArch "x64"
#endif

#ifndef MyCompression
  #define MyCompression "lzma"
#endif

#ifndef MySolidCompression
  #define MySolidCompression "yes"
#endif

[Setup]
; Inno requires "{{" to emit a literal opening brace in AppId.
; Do not add a second closing brace here; that creates a malformed uninstall registry key.
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\{#MyInstallDir}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputBaseFilename=JuyuanLingchuang{#MyOutputSuffix}-Setup-{#MyAppArch}
Compression={#MyCompression}
SolidCompression={#MySolidCompression}
WizardStyle=modern
PrivilegesRequired=lowest
SetupIconFile=src\OpenClaw.Tray.WinUI\Assets\openclaw.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
; Round 2 (Scott #5): block install/uninstall while the tray is running.
; Mutex name matches AppIdentity.MutexBaseName for this build variant.
; Tray and Inno run in the same user session, so no Global\ prefix is needed.
AppMutex={#MyMutex}
#if MyAppArch == "arm64"
ArchitecturesInstallIn64BitMode=arm64
ArchitecturesAllowed=arm64
#else
ArchitecturesInstallIn64BitMode=x64
ArchitecturesAllowed=x64
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; publish folder should be passed via /Dpublish=publish-x64 or /Dpublish=publish-arm64
#ifndef publish
  #define publish "publish"
#endif

#if !FileExists(publish + "\JuyuanLingchuang.exe")
  #error Tray payload missing. Publish JuyuanLingchuang before compiling the installer.
#endif

#if FileExists(publish + "\SetupEngine\OpenClaw.SetupEngine.UI.exe")
  #error SetupEngine.UI.exe should not be shipped. Setup UI is hosted by JuyuanLingchuang.exe.
#endif

; vcRedist should point at the architecture-matching Visual C++ Runtime
; redistributable in CI release builds.
#ifndef vcRedist
  #define vcRedist ""
#endif

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "startupicon"; Description: "Start {#MyAppName} when Windows starts"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
; WinUI Tray app - include all files (WinUI needs DLLs, not single-file)
Source: "{#publish}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
; WSL gateway uninstall helper copied to {tmp} by [Code] during uninstall.
Source: "scripts\Uninstall-LocalGateway.ps1"; DestDir: "{app}"; Flags: ignoreversion
#if vcRedist != ""
Source: "{#vcRedist}"; DestDir: "{tmp}"; DestName: "vc_redist.exe"; Flags: deleteafterinstall; AfterInstall: InstallVCRuntime
#endif

[Registry]
Root: HKCU; Subkey: "Software\Classes\{#MyProtocol}"; ValueType: string; ValueName: ""; ValueData: "URL:聚元灵创协议"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\{#MyProtocol}"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\Classes\{#MyProtocol}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"",0"
Root: HKCU; Subkey: "Software\Classes\{#MyProtocol}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppAumid}"
Name: "{group}\聚元灵创设置"; Filename: "{app}\{#MyAppExeName}"; Parameters: "{#MyProtocol}://commandcenter"; IconFilename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppAumid}"
Name: "{group}\聚元灵创对话"; Filename: "{app}\{#MyAppExeName}"; Parameters: "{#MyProtocol}://chat"; IconFilename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppAumid}"
Name: "{group}\检查更新"; Filename: "{app}\{#MyAppExeName}"; Parameters: "{#MyProtocol}://check-updates"; IconFilename: "{app}\{#MyAppExeName}"; AppUserModelID: "{#MyAppAumid}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon; AppUserModelID: "{#MyAppAumid}"
Name: "{userstartup}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: startupicon; AppUserModelID: "{#MyAppAumid}"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent; Check: ShouldLaunchTray

[Code]
var
  VCRuntimeInstallSucceeded: Boolean;
  LocalGatewayCleanupChoiceInitialized: Boolean;
  LocalGatewayCleanupRequested: Boolean;
  LocalGatewayCleanupSucceeded: Boolean;

#if vcRedist != ""
procedure InstallVCRuntime;
var
  ResultCode: Integer;
  Started: Boolean;
begin
  VCRuntimeInstallSucceeded := False;
  Log('Running bundled Visual C++ Runtime redistributable.');
  Started :=
    Exec(
      ExpandConstant('{tmp}\vc_redist.exe'),
      '/install /quiet /norestart',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);

  if not Started then
  begin
    Log('Failed to start Visual C++ Runtime redistributable. System error: ' + IntToStr(ResultCode) + '.');
    Exit;
  end;

  VCRuntimeInstallSucceeded := (ResultCode = 0) or (ResultCode = 3010) or (ResultCode = 1641);
  if VCRuntimeInstallSucceeded then
    Log('Visual C++ Runtime redistributable exited with success code ' + IntToStr(ResultCode) + '.')
  else
    Log('Visual C++ Runtime redistributable failed with exit code ' + IntToStr(ResultCode) + '.');
end;
#endif

function ShouldLaunchTray: Boolean;
begin
#if vcRedist != ""
  Result := VCRuntimeInstallSucceeded;
  if not Result then
    Log('Skipping post-install tray launch because Visual C++ Runtime installation did not succeed.');
#else
  Result := True;
#endif
end;

procedure EnsureLocalGatewayCleanupChoice;
begin
  if LocalGatewayCleanupChoiceInitialized then
    Exit;

  LocalGatewayCleanupChoiceInitialized := True;

  if UninstallSilent() then
  begin
    LocalGatewayCleanupRequested := True;
    Log('Silent uninstall: local gateway cleanup will run automatically.');
  end
  else
  begin
    LocalGatewayCleanupRequested :=
      MsgBox(
        '是否同时删除聚元灵创本地 WSL 网关？' + #13#10#13#10 +
        '若你只用远程/平台网关（未在本机装过 WSL 网关），请选“否”。' + #13#10#13#10 +
        '选择“是”将尝试注销 {#MyDistroName} WSL 发行版并清理本地网关状态。' + #13#10 +
        '选择“否”将保留本机本地网关及生成状态，并直接继续卸载。',
        mbConfirmation,
        MB_YESNO or MB_DEFBUTTON2) = IDYES;

    if LocalGatewayCleanupRequested then
      Log('User chose to remove the local WSL gateway.')
    else
      Log('User chose to preserve the local WSL gateway and generated state.');
  end;
end;

function RunLocalGatewayCleanupOnce(var ResultCode: Integer): Boolean;
var
  SourceScriptPath: string;
  TempScriptPath: string;
  Params: string;
begin
  SourceScriptPath := ExpandConstant('{app}\Uninstall-LocalGateway.ps1');
  TempScriptPath := ExpandConstant('{tmp}\Uninstall-LocalGateway.ps1');

  if not FileExists(SourceScriptPath) then
  begin
    ResultCode := 2;
    Log('Local gateway cleanup script is missing: ' + SourceScriptPath);
    Result := False;
    Exit;
  end;

  if FileExists(TempScriptPath) then
    DeleteFile(TempScriptPath);

  if not CopyFile(SourceScriptPath, TempScriptPath, False) then
  begin
    ResultCode := 3;
    Log('Failed to copy local gateway cleanup script to: ' + TempScriptPath);
    Result := False;
    Exit;
  end;

  Params :=
    '-NoProfile -ExecutionPolicy Bypass -File ' + AddQuotes(TempScriptPath) +
    ' -AppRoot ' + AddQuotes(ExpandConstant('{app}')) +
    ' -DataDirectoryName ' + AddQuotes('{#MyInstallDir}') +
    ' -AutoStartName ' + AddQuotes('{#MyAutoStartName}') +
    ' -StartupTaskName ' + AddQuotes('{#MyStartupTaskName}') +
    ' -DistroName ' + AddQuotes('{#MyDistroName}');

  Log('Running local gateway cleanup script from {tmp}.');
  Result :=
    Exec(
      ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Params,
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);

  if Result then
    Log('Local gateway cleanup script exited with code ' + IntToStr(ResultCode) + '.')
  else
    Log('Failed to start local gateway cleanup script. System error: ' + IntToStr(ResultCode) + '.');
end;

procedure RunLocalGatewayCleanup;
var
  ResultCode: Integer;
  Started: Boolean;
begin
  if not LocalGatewayCleanupRequested then
    Exit;

  LocalGatewayCleanupSucceeded := False;
  UninstallProgressForm.StatusLabel.Caption := '正在清理本地网关...';
  Started := RunLocalGatewayCleanupOnce(ResultCode);

  if Started and (ResultCode = 0) then
  begin
    LocalGatewayCleanupSucceeded := True;
    Log('Local gateway cleanup completed successfully.');
    Exit;
  end;

  // Product clients often pair to a remote gateway and never create a local WSL
  // distro. Do not block uninstall on cleanup failure; keep going and leave a log.
  Log('Local gateway cleanup failed (exit ' + IntToStr(ResultCode) + '); continuing uninstall.');
  if not UninstallSilent() then
    MsgBox(
      '本地 WSL 网关清理未完成（退出码: ' + IntToStr(ResultCode) + '）。' + #13#10#13#10 +
      '这通常不影响卸载：本机可能从未安装本地网关，或 WSL 当前不可用。' + #13#10 +
      '将继续卸载聚元灵创。',
      mbInformation,
      MB_OK);
end;

procedure DeleteGeneratedAppState;
begin
  if not LocalGatewayCleanupSucceeded then
    Exit;

  if DelTree(ExpandConstant('{app}'), True, True, True) then
    Log('Deleted generated app state from {app}.')
  else
    Log('Generated app state in {app} could not be fully deleted; continuing uninstall.');
end;

procedure RemoveAppAutoStart;
var
  ResultCode: Integer;
  Started: Boolean;
begin
  if RegDeleteValue(
      HKCU,
      'SOFTWARE\Microsoft\Windows\CurrentVersion\Run',
      '{#MyAutoStartName}') then
    Log('Removed {#MyAutoStartName} autostart registry value.')
  else
    Log('{#MyAutoStartName} autostart registry value already absent.');

  Started :=
    Exec(
      ExpandConstant('{sys}\schtasks.exe'),
      '/Delete /TN ' + AddQuotes('{#MyStartupTaskName}') + ' /F',
      '',
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode);
  if Started and (ResultCode = 0) then
    Log('Removed {#MyStartupTaskName} startup task.')
  else
    Log('{#MyStartupTaskName} startup task already absent or unavailable.');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RemoveAppAutoStart;
    EnsureLocalGatewayCleanupChoice;
    RunLocalGatewayCleanup;
  end
  else if CurUninstallStep = usPostUninstall then
  begin
    DeleteGeneratedAppState;
  end;
end;
