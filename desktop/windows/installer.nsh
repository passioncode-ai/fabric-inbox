; NSIS include for the per-user installer (desktop/dist-platform.mjs, PL-01, PL-04): the
; fabric-inbox:// connect link is registered under HKCU\Software\Classes at install and removed at
; uninstall. No elevation: everything is in the person's own hive. The app registers the same keys
; again at launch (app.setAsDefaultProtocolClient), so a moved install keeps working.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\fabric-inbox" "" "URL:Fabric Inbox connect link"
  WriteRegStr HKCU "Software\Classes\fabric-inbox" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\fabric-inbox\DefaultIcon" "" "$INSTDIR\Fabric Inbox.exe,0"
  WriteRegStr HKCU "Software\Classes\fabric-inbox\shell\open\command" "" '"$INSTDIR\Fabric Inbox.exe" "%1"'
!macroend
!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\fabric-inbox"
!macroend
