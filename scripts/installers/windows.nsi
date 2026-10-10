Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "StrFunc.nsh"
${StrStr}
${UnStrStr}
Name "BeefTV"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\Programs\BeefTV"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "BeefTV"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "BeefTV Setup"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"

!macro RequireClosed PREFIX
Function ${PREFIX}RequireClosed
  nsExec::ExecToStack '"$SYSDIR\tasklist.exe" /FI "IMAGENAME eq BeefTV.exe" /NH'
  Pop $0
  Pop $1
!if "${PREFIX}" == "un."
  ${UnStrStr} $2 $1 "BeefTV.exe"
!else
  ${StrStr} $2 $1 "BeefTV.exe"
!endif
  ${If} $2 == ""
!if "${PREFIX}" == "un."
    ${UnStrStr} $2 $1 "beeftv.exe"
!else
    ${StrStr} $2 $1 "beeftv.exe"
!endif
  ${EndIf}
  ${If} $0 != 0
  ${OrIf} $2 != ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "Please close BeefTV and its CLI before installing or uninstalling." /SD IDOK
    SetErrorLevel 2
    Abort
  ${EndIf}
FunctionEnd
!macroend
!insertmacro RequireClosed ""
!insertmacro RequireClosed "un."

Function .onInit
  SetShellVarContext current
  # A fixed app-owned directory prevents /D from targeting the user's project data.
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\BeefTV"
  Call RequireClosed
FunctionEnd

Function un.onInit
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\BeefTV"
  Call un.RequireClosed
FunctionEnd

Section "BeefTV (required)" SEC_APP
  SectionIn RO
  SetOutPath "$INSTDIR"
  # Replace only shipped runtime directories; never touch AppData\BeefTV.
  RMDir /r "$INSTDIR\agent-host"
  RMDir /r "$INSTDIR\plugin-packages"
  RMDir /r "$INSTDIR\cli"
  RMDir /r "$INSTDIR\media-runtime"
  ClearErrors
  File /r "${PAYLOAD}\*"
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Installation failed. Please run the installer again. Your projects have been preserved." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\BeefTV"
  CreateShortcut "$SMPROGRAMS\BeefTV\BeefTV.lnk" "$INSTDIR\BeefTV.exe"
  CreateShortcut "$SMPROGRAMS\BeefTV\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayName" "BeefTV"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "UninstallString" '$\"$INSTDIR\Uninstall.exe$\"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "QuietUninstallString" '$\"$INSTDIR\Uninstall.exe$\" /S'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "DisplayIcon" "$INSTDIR\BeefTV.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV" "NoRepair" 1
SectionEnd

Section /o "Desktop shortcut" SEC_DESKTOP
  CreateShortcut "$DESKTOP\BeefTV.lnk" "$INSTDIR\BeefTV.exe"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\BeefTV.exe"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /r "$INSTDIR\agent-host"
  RMDir /r "$INSTDIR\plugin-packages"
  RMDir /r "$INSTDIR\cli"
  RMDir /r "$INSTDIR\media-runtime"
  RMDir "$INSTDIR"
  Delete "$DESKTOP\BeefTV.lnk"
  Delete "$SMPROGRAMS\BeefTV\BeefTV.lnk"
  Delete "$SMPROGRAMS\BeefTV\Uninstall.lnk"
  RMDir "$SMPROGRAMS\BeefTV"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\BeefTV"
SectionEnd
