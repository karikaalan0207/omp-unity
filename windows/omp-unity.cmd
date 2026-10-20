@echo off
setlocal
rem Opens the omp-unity workspace inside the default WSL distribution.
rem Set OMP_WSL_DISTRO to target a specific distro (for example Ubuntu-24.04).
set "OMP_WSL_DISTRO=%OMP_WSL_DISTRO%"
if "%OMP_WSL_DISTRO%"=="" (
  wsl.exe -- zsh -lic "exec ~/.omp/agent/launchers/omp-unity-wsl.sh"
) else (
  wsl.exe -d "%OMP_WSL_DISTRO%" -- zsh -lic "exec ~/.omp/agent/launchers/omp-unity-wsl.sh"
)
