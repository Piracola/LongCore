; ============================================================
; LongCore 0.1.0 — Inno Setup 6 安装器脚本
; 消费 bin\publish\(由 installer\build-installer.cmd 产出)
; 编译: iscc installer\LongCore.iss
; ============================================================

#define MyAppName "LongCore"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "Piracola"
#define MyAppExeName "LongCore.exe"
#define MyAppId "{{D4A7C921-6B3E-4F8A-9C1D-2E5B7A8F0C63}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\LongCore
DefaultGroupName=LongCore
UninstallDisplayIcon={app}\{#MyAppExeName}
; EC/驱动访问需要管理员
PrivilegesRequired=admin
; 与 App.xaml.cs 的互斥体联动: 安装/升级时提示关闭运行中的实例
AppMutex=LongCore_Main_Instance
CloseApplications=yes
RestartApplications=no
SetupIconFile=..\JiaoLongControl\Server\Resources\Icons\app.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
OutputDir=Output
OutputBaseFilename=LongCore-{#MyAppVersion}-setup
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; 主程序 + 驱动 + 全部运行时依赖(dotnet publish 产物, 递归整树)
Source: "..\bin\publish\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; 可选: WebView2 常青版引导器(放入 installer\ 目录并按此命名, 缺省跳过)
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: skipifsourcedoesntexist
; 可选: .NET 8 Desktop Runtime 离线安装器(同上)
Source: "windowsdesktop-runtime-8.0-win-x64.exe"; DestDir: "{tmp}"; Flags: skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 依赖检查与安装(静默, 仅在缺失且安装包在旁边时执行)
Filename: "{tmp}\windowsdesktop-runtime-8.0-win-x64.exe"; \
    Parameters: "/install /quiet /norestart"; \
    StatusMsg: "安装 .NET 8 Desktop Runtime..."; Flags: skipifdoesntexist runhidden; Check: not DotNet8Installed
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; \
    Parameters: "/silent /install"; \
    StatusMsg: "安装 WebView2 Runtime..."; Flags: skipifdoesntexist runhidden; Check: not WebView2Installed
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent

[Code]
// .NET 8 Desktop Runtime 检测: 共享框架版本表里存在 8.x 项即视为已安装
function DotNet8Installed(): Boolean;
var
    key: String;
    names: TArrayOfString;
    i: Integer;
begin
    Result := False;
    key := 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App';
    if RegGetValueNames(HKLM, key, names) then
    begin
        for i := 0 to GetArrayLength(names) - 1 do
            if Copy(names[i], 1, 2) = '8.' then
            begin
                Result := True;
                exit;
            end;
    end;
end;

function WebView2Installed(): Boolean;
begin
    // 常青版安装检测(官方推荐键)
    Result :=
        RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
        RegKeyExists(HKCU, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') or
        RegKeyExists(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
end;
