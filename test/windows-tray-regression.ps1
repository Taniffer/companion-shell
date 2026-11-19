$ErrorActionPreference='Stop'
$sourceRoot=Split-Path -Parent $PSScriptRoot
$path=Join-Path $sourceRoot 'scripts/tray.ps1'
$parseErrors=$null
$tokens=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$parseErrors)
if($parseErrors.Count){throw $parseErrors[0]}
$automatic=$ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.VariableExpressionAst] -and $node.VariablePath.UserPath -ieq 'input'
},$true)
if($automatic.Count){throw 'Do not use the automatic $input variable for a UI control.'}
function Assert-True($Value,$Message){if(-not $Value){throw $Message}}
function Get-Callback($Method){
    $call=$ast.Find({
        param($node)
        $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and $node.Member.Value -eq $Method
    },$true)
    if(-not $call){throw ('Missing event '+$Method)}
    $block=$call.Arguments[0].Find({
        param($node)
        $node -is [System.Management.Automation.Language.ScriptBlockExpressionAst]
    },$true)
    $raw=$block.ScriptBlock.Extent.Text
    return [scriptblock]::Create($raw.Substring(1,$raw.Length-2))
}
$parent=Join-Path $sourceRoot 'test/.runtime'
New-Item -ItemType Directory -Path $parent -Force|Out-Null
$fixtureRoot=Join-Path $parent ('tray-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot|Out-Null
$textEncoding=New-Object Text.UTF8Encoding($false)
$draftFile=Join-Path $fixtureRoot 'draft.json'
$captureTextBox=[pscustomobject]@{Text='';IsDisposed=$false;Focused=$false}
$captureTextBox|Add-Member ScriptMethod Focus {$this.Focused=$true;return $true}
$saveButton=[pscustomobject]@{Enabled=$true;IsDisposed=$false;Clicks=0}
$saveButton|Add-Member ScriptMethod PerformClick {$this.Clicks++}
$captureForm=[pscustomobject]@{Closed=$false}
$captureForm|Add-Member ScriptMethod Close {$this.Closed=$true}
$hintLabel=[pscustomobject]@{Text=''}
$sendState=@{id=[guid]::NewGuid().ToString();lastText=$null}
$currentSettings=[pscustomobject]@{dataDir=$fixtureRoot}

$shown=(Get-Callback 'Add_Shown').GetNewClosure()
& $shown
Assert-True $captureTextBox.Focused 'Shown lost the captured text control.'
Write-Output 'PASS: native event closure preserves the text control.'

# The first Add_Click belongs to Paste. Select the actual save control.
$saveCall=$ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -and
    $node.Member.Value -eq 'Add_Click' -and $node.Expression.VariablePath.UserPath -eq 'saveButton'
},$true)
$saveBlock=$saveCall.Arguments[0].Find({param($node)$node -is [System.Management.Automation.Language.ScriptBlockExpressionAst]},$true).ScriptBlock.Extent.Text
$saveSource=[scriptblock]::Create($saveBlock.Substring(1,$saveBlock.Length-2))
$saveHandler=$saveSource.GetNewClosure()
& $saveHandler
Assert-True $saveButton.Enabled 'Empty saves left the button disabled.'
Write-Output 'PASS: empty save has no unhandled callback exception.'

$assignment=$ast.Find({
    param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.VariablePath.UserPath -eq 'writeDraft'
},$true)
$draftBlock=$assignment.Right.Find({param($node)$node -is [System.Management.Automation.Language.ScriptBlockExpressionAst]},$true).ScriptBlock.Extent.Text
$writeDraft=([scriptblock]::Create($draftBlock.Substring(1,$draftBlock.Length-2))).GetNewClosure()
$captureTextBox.Text='TRAY_CLOSURE_DRAFT_验证'
$changed=(Get-Callback 'Add_TextChanged').GetNewClosure()
& $changed
$saved=Get-Content -LiteralPath $draftFile -Raw -Encoding UTF8|ConvertFrom-Json
Assert-True ($saved.text -eq $captureTextBox.Text) 'Editing did not persist a Unicode draft.'
$closing=(Get-Callback 'Add_FormClosing').GetNewClosure()
$closeEvent=[pscustomobject]@{Cancel=$false}
& $closing $null $closeEvent
Assert-True (-not $closeEvent.Cancel) 'Normal closing failed.'
Write-Output 'PASS: input and close use the same atomic Unicode draft.'

[IO.File]::WriteAllText((Join-Path $fixtureRoot 'admin.key'),'fixture-local-only',$textEncoding)
[IO.File]::WriteAllText((Join-Path $fixtureRoot 'status.json'),'{"uiUrl":"http://127.0.0.1:1"}',$textEncoding)
$saveHandler=$saveSource.GetNewClosure()
& $saveHandler
$attemptId=$sendState.id
& $saveHandler
Assert-True ($sendState.id -eq $attemptId -and $saveButton.Enabled -and -not $captureForm.Closed) 'Failed saves lost the retry ID or closed the draft.'
Write-Output 'PASS: failed local delivery keeps the draft, retry ID and enabled save control.'

$writeDraft={throw 'Injected disk failure'}
$failedClosing=(Get-Callback 'Add_FormClosing').GetNewClosure()
$closeEvent=[pscustomobject]@{Cancel=$false}
& $failedClosing $null $closeEvent
Assert-True $closeEvent.Cancel 'Draft storage failure must keep the editor open.'
Write-Output 'PASS: failed draft storage preserves the editor.'

Add-Type -AssemblyName System.Windows.Forms
$keyHandler=(Get-Callback 'Add_KeyDown').GetNewClosure()
$enter=[pscustomobject]@{Control=$true;KeyCode=[Windows.Forms.Keys]::Enter;SuppressKeyPress=$false}
& $keyHandler $null $enter
Assert-True ($enter.SuppressKeyPress -and $saveButton.Clicks -eq 1) 'Ctrl+Enter did not call the save control.'
$escape=[pscustomobject]@{Control=$false;KeyCode=[Windows.Forms.Keys]::Escape;SuppressKeyPress=$false}
& $keyHandler $null $escape
Assert-True $captureForm.Closed 'Escape did not close the editor.'
Write-Output 'PASS: keyboard save and close use the captured controls.'
