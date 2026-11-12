; HT Flow NSIS installer hooks (referenced from tauri.conf.json -> bundle.windows.nsis.installerHooks).
; The macros below are expanded inside Tauri's own installer.nsi, so ${PRODUCTNAME} and
; ${MAINBINARYNAME} are defined there.

; Make sure the desktop shortcut exists (Start-menu entry is created by Tauri; startMenuFolder is set).
!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$DESKTOP\${PRODUCTNAME}.lnk" +2 0
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
!macroend

; Uninstall: ask whether to keep or remove the user data. HT Flow keeps profiles, settings, the
; vault and recorded ticks in %APPDATA%\HTFlow (outside the install folder), so removing the app
; never touches them unless the user says so. Silent uninstalls and updates (the old version is
; removed with /UPDATE) always keep the data.
!macro NSIS_HOOK_POSTUNINSTALL
  IfSilent htflow_done
  IfFileExists "$APPDATA\HTFlow\*.*" 0 htflow_done
  Push $R8
  Push $R9
  Push $R7
  StrLen $R9 "$CMDLINE"
  StrCpy $R8 0
  htflow_scan:
    IntCmp $R8 $R9 htflow_ask htflow_ask 0
    StrCpy $R7 "$CMDLINE" 7 $R8
    StrCmp $R7 "/UPDATE" htflow_skip
    IntOp $R8 $R8 + 1
    Goto htflow_scan
  htflow_skip:
    Pop $R7
    Pop $R9
    Pop $R8
    Goto htflow_done
  htflow_ask:
    Pop $R7
    Pop $R9
    Pop $R8
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also remove your HT Flow data?$\r$\n$\r$\nThis deletes your profiles, settings, saved workspaces and recorded market data in:$\r$\n$APPDATA\HTFlow$\r$\n$\r$\nChoose No to keep it for a later re-install." \
      IDYES htflow_remove IDNO htflow_done
  htflow_remove:
    RMDir /r "$APPDATA\HTFlow"
  htflow_done:
!macroend
