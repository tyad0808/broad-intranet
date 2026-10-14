@echo off
chcp 65001 > nul
rem 네스팅 패널을 윈도우 일러스트레이터에 설치한다. 이 파일을 더블클릭.
set "SRC=%~dp0"
set "DEST=%APPDATA%\Adobe\CEP\extensions\com.broad.nesting"

rem 서명하지 않은 사내 확장을 열 수 있게 허용 (CC 2017 ~ 최신)
for %%v in (7 8 9 10 11 12) do reg add "HKCU\Software\Adobe\CSXS.%%v" /v PlayerDebugMode /t REG_SZ /d 1 /f > nul

if exist "%DEST%" rmdir /s /q "%DEST%"
mkdir "%DEST%"
xcopy "%SRC%CSXS" "%DEST%\CSXS\" /e /i /y > nul
xcopy "%SRC%jsx" "%DEST%\jsx\" /e /i /y > nul
copy /y "%SRC%roll.html" "%DEST%\" > nul
copy /y "%SRC%text.html" "%DEST%\" > nul
copy /y "%SRC%panel.js" "%DEST%\" > nul
copy /y "%SRC%text-panel.js" "%DEST%\" > nul
copy /y "%SRC%nest-shape.js" "%DEST%\" > nul
copy /y "%SRC%style.css" "%DEST%\" > nul
echo 설치 완료: %DEST%
echo 일러스트레이터를 다시 켜고 [창 ^> 확장] 에서 '용지 폭 네스팅' 또는 '아크릴 텍스트 네스팅' 을 여세요.
pause
