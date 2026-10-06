; ============================================================
; LongCore 0.1.0 — Inno Setup 6 安装器脚本
; 消费 bin\publish\(由 installer\build-installer.cmd 产出)
; 编译: iscc installer\LongCore.iss
; ============================================================

#define MyAppName "LongCore"
#define MyAppVersion "0.1.4"
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
; 排除 logs\: 运行期日志(App.config 的 log4net RollingFileAppender 写在 publish 目录), 不属于发行内容
Source: "..\bin\publish\*"; DestDir: "{app}"; Excludes: "logs\*,*.log"; Flags: recursesubdirs createallsubdirs ignoreversion
; 可选: WebView2 常青版引导器(放入 installer\ 目录并按此命名, 缺省跳过)
Source: "MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: skipifsourcedoesntexist
; 可选: .NET 10 Desktop Runtime 离线安装器(同上)
Source: "windowsdesktop-runtime-10.0-win-x64.exe"; DestDir: "{tmp}"; Flags: skipifsourcedoesntexist

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
; 依赖检查与安装(静默, 仅在缺失且安装包在旁边时执行)
Filename: "{tmp}\windowsdesktop-runtime-10.0-win-x64.exe"; \
    Parameters: "/install /quiet /norestart"; \
    StatusMsg: "安装 .NET 10 Desktop Runtime..."; Flags: skipifdoesntexist runhidden; Check: not DotNet10Installed
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; \
    Parameters: "/silent /install"; \
    StatusMsg: "安装 WebView2 Runtime..."; Flags: skipifdoesntexist runhidden; Check: not WebView2Installed
; 主程序清单为 requireAdministrator(EC/WMI 需要管理员)。
; postinstall 条目默认按 runasoriginaluser(降权到发起安装前的普通凭据)执行,
; 此时 CreateProcess 会以 740(ERROR_ELEVATION_REQUIRED) 失败 —— 安装结束时勾选"运行"必然报错。
; 必须显式 runascurrentuser: 继承安装器自身的(已提升)凭据, 既不报错也不会多弹一次 UAC。
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent runascurrentuser

[Code]
const
    AppMutexName = 'LongCore_Main_Instance';
    DriverService = 'JiaoLongDriver64';

// .NET 10 Desktop Runtime 检测: 共享框架版本表里存在 10.x 项即视为已安装
function DotNet10Installed(): Boolean;
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
            if Copy(names[i], 1, 3) = '10.' then
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

// ============================================================
// 安装前: 让旧实例优雅退出 + 确保内核驱动已卸载
// ============================================================
function RunAndWait(const FileName, Params: String): Integer;
var
    rc: Integer;
begin
    Result := -1;
    if Exec(FileName, Params, '', SW_HIDE, ewWaitUntilTerminated, rc) then
        Result := rc;
end;

// 用 sc query 的输出判断驱动是否仍在运行, 避免声明一堆服务 API
function DriverServiceRunning(): Boolean;
var
    tmpFile: String;
    lines: TArrayOfString;
    i: Integer;
begin
    Result := False;
    tmpFile := ExpandConstant('{tmp}\drv-state.txt');
    DeleteFile(tmpFile);
    RunAndWait(ExpandConstant('{cmd}'), '/c sc query ' + DriverService + ' > "' + tmpFile + '" 2>&1');
    if LoadStringsFromFile(tmpFile, lines) then
        for i := 0 to GetArrayLength(lines) - 1 do
            if Pos('RUNNING', Uppercase(lines[i])) > 0 then
                Result := True;
end;

// Inno 生命周期: 文件复制之前
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
    i: Integer;
    quitExe: String;
begin
    Result := '';

    // 1) 请正在运行的实例优雅退出(走 EcGuard 恢复 + 驱动卸载), 绝不直接强杀
    quitExe := ExpandConstant('{app}\{#MyAppExeName}');
    if FileExists(quitExe) and CheckForMutexes(AppMutexName) then
    begin
        Log('LongCore 正在运行, 请求优雅退出(--quit)');
        RunAndWait(quitExe, '--quit');
        for i := 1 to 30 do
        begin
            if not CheckForMutexes(AppMutexName) then
                break;
            Sleep(500);
        end;
        if CheckForMutexes(AppMutexName) then
        begin
            if MsgBox('旧版本 LongCore 没有响应退出请求(可能已卡死)。' + #13#10 + #13#10 +
                      '强制结束它并继续安装吗?' + #13#10 +
                      '(若安装后程序无法启动, 请先重启电脑再重装)',
                      mbConfirmation, MB_YESNO) = IDYES then
            begin
                RunAndWait(ExpandConstant('{cmd}'), '/c taskkill /IM {#MyAppExeName} /F');
                Sleep(1500);
            end;
            if CheckForMutexes(AppMutexName) then
            begin
                Result := '旧版本 LongCore 仍在运行, 无法继续安装。' + #13#10 +
                          '请在任务管理器里结束 LongCore.exe, 或重启电脑后重新运行安装程序。';
                exit;
            end;
        end;
    end;

    // 2) 内核驱动仍在运行会锁住驱动文件, 也会让新版本卡在驱动初始化: 尝试停掉, 停不掉就要求重启
    if DriverServiceRunning() then
    begin
        Log('驱动服务 ' + DriverService + ' 仍在运行, 尝试停止');
        RunAndWait(ExpandConstant('{cmd}'), '/c sc stop ' + DriverService);
        Sleep(2000);
        if DriverServiceRunning() then
        begin
            Result := '内核驱动 ' + DriverService + ' 仍在运行且无法停止。' + #13#10 + #13#10 +
                      '它通常是被上一次强制结束的 LongCore 留在了半挂起状态, 此时安装会锁住' + #13#10 +
                      '驱动文件并装出残缺的目录(程序能启动但初始化失败)。' + #13#10 + #13#10 +
                      '请重启电脑后再运行本安装程序。';
            exit;
        end;
    end;
end;

// ============================================================
// 安装后: 关键文件校验, 缺任何一个就回滚, 绝不留下"能启动但初始化失败"的残包
// ============================================================
function CriticalFile(Index: Integer): String;
begin
    case Index of
        0: Result := 'LongCore.exe';
        1: Result := 'LongCore.dll';
        2: Result := 'Drivers\Blding\JiaoLongDriver64.dll';
        3: Result := 'Drivers\Blding\JiaoLongDriver64.sys';
        4: Result := 'WebRoot\index.html';
        5: Result := 'Microsoft.Web.WebView2.Core.dll';
    else
        Result := '';
    end;
end;

// 文件存在且非空(不能只用 FileExists: 0 字节的残文件同样会让程序起不来)
function FileIsNonEmpty(const FileName: String): Boolean;
var
    fr: TFindRec;
begin
    Result := False;
    if FindFirst(FileName, fr) then
    begin
        Result := (fr.SizeHigh > 0) or (fr.SizeLow > 0);
        FindClose(fr);
    end;
end;

function VerifyCriticalFiles(): String;
var
    i: Integer;
    p: String;
begin
    Result := '';
    for i := 0 to 5 do
    begin
        p := ExpandConstant('{app}\') + CriticalFile(i);
        if (not FileExists(p)) or (not FileIsNonEmpty(p)) then
            Result := Result + '    ' + CriticalFile(i) + #13#10;
    end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
    missing: String;
begin
    if CurStep = ssPostInstall then
    begin
        missing := VerifyCriticalFiles();
        if missing <> '' then
        begin
            MsgBox('安装不完整, 以下关键文件缺失或为空:' + #13#10 + #13#10 + missing + #13#10 +
                   '安装程序将回滚本次安装。' + #13#10 +
                   '常见原因: 安装时这些文件被其它进程占用。请重启电脑后重新安装。',
                   mbCriticalError, MB_OK);
            RaiseException('关键文件缺失, 回滚安装');
        end
        else
            Log('关键文件校验通过');
    end;
end;
