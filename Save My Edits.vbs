' Save My Edits.vbs - double-click to open the live composition preview.
'
' What happens:
'   1. Node.js is checked (the project needs it anyway).
'   2. node_modules is checked (dependencies installed).
'   3. tools\launch-preview.ts starts the helper and opens the browser;
'      its output goes to temp\preview-launch.log.
'   4. If anything fails, a message box tells you what to do instead of
'      failing silently. Double-clicking while it is already running
'      simply re-opens the preview.
Option Explicit

Dim shell, fso, here, logPath, result

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' 1. Node.js must be on PATH.
result = shell.Run("cmd /c node --version >nul 2>&1", 0, True)
If result <> 0 Then
  MsgBox "Node.js is not installed (or not on PATH)." & vbCrLf & vbCrLf & _
         "Install Node.js 22.5+ from https://nodejs.org, then run this file again.", _
         vbExclamation, "Save My Edits"
  WScript.Quit 1
End If

' 2. Dependencies must be installed.
If Not fso.FolderExists(here & "\node_modules") Then
  MsgBox "Dependencies are not installed yet." & vbCrLf & vbCrLf & _
         "Open a terminal in this folder and run:  npm install" & vbCrLf & _
         "Then double-click this file again.", _
         vbExclamation, "Save My Edits"
  WScript.Quit 1
End If

If Not fso.FolderExists(here & "\temp") Then fso.CreateFolder(here & "\temp")
logPath = here & "\temp\preview-launch.log"

' 3. Run the launcher hidden and capture its output; wait for the exit code.
result = shell.Run("cmd /c node --import tsx ""tools\launch-preview.ts"" > """ & logPath & """ 2>&1", 0, True)

If result <> 0 Then
  Dim message
  message = "The live preview could not be started." & vbCrLf & vbCrLf & _
            "Details were written to:" & vbCrLf & logPath & vbCrLf & vbCrLf & _
            "Quick checks:" & vbCrLf & _
            "  * run  npm install  in this folder" & vbCrLf & _
            "  * run  npm run preview:launch  in a terminal for the full error"
  If fso.FileExists(logPath) Then
    Dim stream, tail
    Set stream = fso.OpenTextFile(logPath, 1)
    tail = stream.ReadAll()
    stream.Close()
    If Len(tail) > 1200 Then tail = Right(tail, 1200)
    message = message & vbCrLf & vbCrLf & "---- last lines of the log ----" & vbCrLf & tail
  End If
  MsgBox message, vbCritical, "Save My Edits"
  WScript.Quit 1
End If
