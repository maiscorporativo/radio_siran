@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title Rádio Siran - Instalação do notebook

echo ==========================================================
echo   Rádio Siran - preparar este notebook como player da loja
echo ==========================================================
echo.
echo Cole o LINK DO PLAYER da unidade (painel ^> Unidades ^> Copiar link)
echo Ex.: https://radio.seudominio.com.br/player/?t=XXXXXXXX
echo.
set /p PLAYER_URL=Link do player:
if "%PLAYER_URL%"=="" (
  echo Link não informado. Abortando.
  pause
  exit /b 1
)

set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo Google Chrome não encontrado. Instale o Chrome e rode este script novamente.
  pause
  exit /b 1
)

echo.
echo [1/3] Ajustando energia: nunca suspender/hibernar na tomada, tampa fechada = não fazer nada...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 10
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

echo [2/3] Criando inicialização automática do player...
set "STARTUP=%AppData%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\RadioSiranPlayer.bat"
(
  echo @echo off
  echo timeout /t 20 /nobreak ^>nul
  echo start "" "%CHROME%" --kiosk --autoplay-policy=no-user-gesture-required --noerrdialogs --disable-session-crashed-bubble --disable-infobars --disable-features=Translate --check-for-update-interval=31536000 --user-data-dir="%LocalAppData%\RadioSiranChrome" "%PLAYER_URL%"
) > "%LAUNCHER%"

echo [3/3] Abrindo o player agora...
start "" "%LAUNCHER%"

echo.
echo Pronto! O player abrirá sozinho sempre que o Windows iniciar.
echo  - Para sair da tela cheia: Alt+F4
echo  - Para remover: apague "%LAUNCHER%"
echo.
pause
