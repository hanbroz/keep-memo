# 창 안의 상대 좌표를 클릭한다. shot.ps1 과 짝이다 — shot 이 담은 PNG 의
# 픽셀 좌표를 그대로 넘기면 그 자리가 눌린다(둘 다 GetWindowRect 기준).
# 개발 중 눈으로 확인할 때만 쓰는 도구다.
param(
  [Parameter(Mandatory=$true)][string]$TitleLike,
  [Parameter(Mandatory=$true)][int]$X,
  [Parameter(Mandatory=$true)][int]$Y
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Clk {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

[void][Clk]::SetProcessDPIAware()

$p = Get-Process | Where-Object { $_.MainWindowTitle -like $TitleLike } | Select-Object -First 1
if ($null -eq $p) { Write-Output "NOTFOUND: '$TitleLike'"; exit 1 }

[void][Clk]::SetForegroundWindow($p.MainWindowHandle)
Start-Sleep -Milliseconds 500

$r = New-Object Clk+RECT
[void][Clk]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$sx = $r.L + $X
$sy = $r.T + $Y
[void][Clk]::SetCursorPos($sx, $sy)
Start-Sleep -Milliseconds 200
[Clk]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
[Clk]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 400
Write-Output "OK: '$($p.MainWindowTitle)' 안 ($X,$Y) -> 화면 ($sx,$sy)"
