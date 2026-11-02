; Lets Windows list Backstage under "Open with" and lets other programs find the exe.
; Nothing here changes which program is the default for any file type.
; It also removes the app's old install from when it was called Clip Editor (another app ID, so
; Windows treats it as a separate app): its own uninstaller runs quietly and keeps the user's data,
; which Backstage copies over the first time it starts (keepOldData in main.js).
!define OLD_CLIP_EDITOR_GUID "e5818e60-f072-5809-a6c8-abb1226f8029"

!macro removeOldClipEditor
  ReadRegStr $R2 SHELL_CONTEXT "Software\${OLD_CLIP_EDITOR_GUID}" "InstallLocation"
  ${If} $R2 == ""
    ReadRegStr $R2 HKCU "Software\${OLD_CLIP_EDITOR_GUID}" "InstallLocation"
  ${EndIf}
  ${If} $R2 == ""
  ${AndIf} ${FileExists} "$LOCALAPPDATA\Programs\Clip Editor\Uninstall Clip Editor.exe"
    StrCpy $R2 "$LOCALAPPDATA\Programs\Clip Editor"
  ${EndIf}
  ${If} $R2 != ""
  ${AndIf} ${FileExists} "$R2\Uninstall Clip Editor.exe"
    DetailPrint "Removing Clip Editor (now Backstage)..."
    CopyFiles /SILENT "$R2\Uninstall Clip Editor.exe" "$PLUGINSDIR\old-clip-editor-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-clip-editor-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$R2' $R3
    Delete "$PLUGINSDIR\old-clip-editor-uninstaller.exe"
    ; with _?= the uninstaller can't remove its own folder; only ever this one folder
    StrCpy $R4 $R2 "" -12
    ${If} $R4 == "\Clip Editor"
      RMDir /r "$R2"
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\Backstage.exe" "" "$INSTDIR\Backstage.exe"
  WriteRegStr SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\Backstage.exe" "Path" "$INSTDIR"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe" "FriendlyAppName" "Backstage"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe\shell\open\command" "" '"$INSTDIR\Backstage.exe" "%1"'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe\SupportedTypes" ".mp4" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe\SupportedTypes" ".mkv" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe\SupportedTypes" ".mov" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe\SupportedTypes" ".webm" ""
  !insertmacro removeOldClipEditor
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Microsoft\Windows\CurrentVersion\App Paths\Backstage.exe"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\Backstage.exe"
!macroend
