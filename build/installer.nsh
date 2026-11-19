# 安装 / 升级前的进程兜底
#
# 背景（两个真实故障，都在这台机器上复现过）：
# 1) 程序还在跑时安装，electron-builder 默认的 CHECK_APP_RUNNING 会弹「Pile 无法关闭，
#    请手动关闭它然后单击重试以继续」；用户点取消后旧卸载器因文件占用失败，再报
#    「Failed to uninstall old application files. ... : 2」。
#    → 这里在 .onInit（早于 CHECK_APP_RUNNING、早于向导页）就把旧实例结束掉。
# 2) 如果安装包本身放在「低完整性级别」的目录里（例如某些沙箱工作区，进程以 Low IL 运行），
#    安装器杀不掉 Medium IL 的程序，只会继续走到默认提示，用户完全看不懂。
#    → 杀完后再数一次进程：还在，就直接告诉用户换个目录运行并退出。

!macro customInit
  ; 1) 按进程名结束（taskkill 走 Unicode 命令行，中文进程名没问题）
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 800

  ; 2) 兜底：按注册表里的安装目录匹配进程路径再结束，防止改名/大小写差异漏网
  ReadRegStr $R9 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R9 != ""
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "Get-Process | Where-Object { $$_.Path -like '$R9\*' } | Stop-Process -Force -ErrorAction SilentlyContinue"`
    Pop $0
  ${EndIf}

  Sleep 800

  ; 3) 复核：进程还在说明这次没有权限结束它（多见于以低完整性级别运行的目录）
  StrCpy $R7 "${APP_EXECUTABLE_FILENAME}" -4          ; 去掉 .exe 得到进程名
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -C "if (@(Get-Process -Name '$R7' -ErrorAction SilentlyContinue).Count -gt 0) { 'RUNNING' } else { 'STOPPED' }"`
  Pop $0                                               ; 退出码
  Pop $1                                               ; stdout（可能带换行）
  StrCpy $2 $1 7                                       ; 只取前 7 个字符
  ${If} $2 == "RUNNING"
    MessageBox MB_ICONSTOP|MB_OK "无法结束正在运行的「Pile」。$\r$\n$\r$\n当前这个文件夹里的程序是受限运行的，没有权限结束已经打开的窗口。$\r$\n$\r$\n请把安装包复制到桌面或「下载」文件夹，再双击运行。"
    Quit
  ${EndIf}

  ; 给文件句柄一点时间释放，避免紧接着的 uninstallOldVersion 撞上占用
  Sleep 300
!macroend
