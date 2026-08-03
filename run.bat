@echo off
rem ---------------------------------------------------------------------
rem Keep Sticky launcher.
rem
rem Build artifacts are named KeepSticky-yyyy.MM.dd.HH.mm.exe, so sorting
rem by name in reverse order is the same as sorting by build time. Take
rem the first entry and run it, so there is nothing to pick by hand after
rem a rebuild.
rem
rem This file is deliberately ASCII only, and deliberately does NOT call
rem chcp. cmd.exe reads a .bat by byte offset using the console OEM
rem codepage; non-ASCII text can be mis-sliced into commands, and calling
rem chcp mid-file desyncs the parser for every line after it. Both were
rem observed on this machine before this comment was written.
rem
rem macOS gets its own launcher later. .bat is Windows only.
rem ---------------------------------------------------------------------

setlocal
cd /d "%~dp0"

if not exist "dist\KeepSticky-*.exe" goto nobuild

for /f "delims=" %%F in ('dir /b /o-n "dist\KeepSticky-*.exe"') do (
    set "EXE=dist\%%F"
    goto run
)

:nobuild
echo.
echo   No build found in dist\
echo.
echo   Build one first:
echo       npm run dist
echo.
pause
exit /b 1

:run
echo   Launching %EXE%
start "" "%EXE%"
exit /b 0
