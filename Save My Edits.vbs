' Save My Edits - double-click to open the live preview, ready to save.
'
' Runs the preview helper as a background process with NO visible window, then
' opens the preview page. Double-clicking again while it is already running
' simply re-opens the preview. Requires Node.js on PATH (already installed for
' this project).
Option Explicit

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = here

' 0 = hidden window, False = do not wait for it to finish.
shell.Run "cmd /c node --import tsx ""tools\launch-preview.ts""", 0, False
