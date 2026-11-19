param([switch]$OpenCapture)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ownsMutex=$false
$mutex=[Threading.Mutex]::new($false,'Local\CompanionMVPTray')
$showRequest=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,'Local\CompanionMVPTray.Show')
$stopRequest=[Threading.EventWaitHandle]::new($false,[Threading.EventResetMode]::AutoReset,'Local\CompanionMVPTray.Stop')
try{$ownsMutex=$mutex.WaitOne(0,$false)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
if(-not $ownsMutex){
    if($OpenCapture){$showRequest.Set()|Out-Null}
    $showRequest.Dispose()
    $stopRequest.Dispose()
    $mutex.Dispose()
    exit
}
[Windows.Forms.Application]::EnableVisualStyles()
$installRoot=Join-Path $env:LOCALAPPDATA 'CompanionMVP'
$settings=Get-Content -LiteralPath (Join-Path $installRoot 'settings.json') -Raw -Encoding UTF8|ConvertFrom-Json
$script:captureForm=$null
$script:draftPath=Join-Path $settings.dataDir 'windows-draft.json'
$utf8=New-Object Text.UTF8Encoding($false)

function Open-Workbench {
    Start-Process -FilePath $settings.nodePath -ArgumentList @('--no-warnings',('"'+(Join-Path $settings.appRoot 'src/main.mjs')+'"')) -WindowStyle Hidden
}
function Open-Capture {
    if($script:captureForm -and -not $script:captureForm.IsDisposed){
        $script:captureForm.Activate()
        return
    }
    $captureForm=New-Object Windows.Forms.Form
    $currentSettings=$settings
    $draftFile=$script:draftPath
    $textEncoding=$utf8
    $sendState=@{id=[Guid]::NewGuid().ToString();lastText=$null}
    $draftText=''
    if(Test-Path -LiteralPath $draftFile){
        try{
            $draftData=Get-Content -LiteralPath $draftFile -Raw -Encoding UTF8|ConvertFrom-Json
            $draftText=[string]$draftData.text
            if($draftData.id){$sendState.id=$draftData.id}
            $sendState.lastText=$draftData.lastText
        }catch{$draftText=[IO.File]::ReadAllText($draftFile)}
    }
    $writeDraft={
        param([string]$Text,[string]$RecordId,$SubmittedText)
        $value=@{id=$RecordId;text=$Text;lastText=$SubmittedText}|ConvertTo-Json
        $temporary=$draftFile+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
        [IO.File]::WriteAllText($temporary,$value,$textEncoding)
        if([IO.File]::Exists($draftFile)){[IO.File]::Replace($temporary,$draftFile,[System.Management.Automation.Language.NullString]::Value)}
        else{[IO.File]::Move($temporary,$draftFile)}
    }.GetNewClosure()

    $script:captureForm=$captureForm
    $captureForm.Text='记一下'
    $captureForm.Size=New-Object Drawing.Size(470,335)
    $captureForm.MinimumSize=New-Object Drawing.Size(390,290)
    $captureForm.StartPosition='CenterScreen'
    $captureForm.TopMost=$true
    $captureForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
    $captureForm.BackColor=[Drawing.Color]::FromArgb(247,248,245)
    $captureForm.KeyPreview=$true
    $label=New-Object Windows.Forms.Label
    $label.Text='留住这一点，之后接着用。'
    $label.Location=New-Object Drawing.Point(18,15)
    $label.AutoSize=$true
    $captureForm.Controls.Add($label)
    # $input is automatic in PowerShell and is reset inside event callbacks.
    $captureTextBox=New-Object Windows.Forms.TextBox
    $captureTextBox.Multiline=$true
    $captureTextBox.AcceptsReturn=$true
    $captureTextBox.ScrollBars='Vertical'
    $captureTextBox.MaxLength=20000
    $captureTextBox.Location=New-Object Drawing.Point(18,46)
    $captureTextBox.Size=New-Object Drawing.Size(417,170)
    $captureTextBox.Anchor='Top,Left,Right,Bottom'
    $captureTextBox.Text=$draftText
    $captureForm.Controls.Add($captureTextBox)
    $hintLabel=New-Object Windows.Forms.Label
    $hintLabel.Text='先登记，不会自动派活。'
    $hintLabel.Location=New-Object Drawing.Point(18,225)
    $hintLabel.Size=New-Object Drawing.Size(410,28)
    $hintLabel.Anchor='Left,Right,Bottom'
    $hintLabel.ForeColor=[Drawing.Color]::FromArgb(100,117,105)
    $captureForm.Controls.Add($hintLabel)
    $saveButton=New-Object Windows.Forms.Button
    $saveButton.Text='记下 · Ctrl+Enter'
    $saveButton.Size=New-Object Drawing.Size(160,34)
    $saveButton.Location=New-Object Drawing.Point(275,260)
    $saveButton.Anchor='Right,Bottom'
    $saveButton.BackColor=[Drawing.Color]::FromArgb(49,91,61)
    $saveButton.ForeColor=[Drawing.Color]::White
    $saveButton.FlatStyle='Flat'
    $captureForm.Controls.Add($saveButton)
    $pasteButton=New-Object Windows.Forms.Button
    $pasteButton.Text='粘贴'
    $pasteButton.Size=New-Object Drawing.Size(72,34)
    $pasteButton.Location=New-Object Drawing.Point(18,260)
    $pasteButton.Anchor='Left,Bottom'
    $pasteButton.Add_Click({
        try{
            if([Windows.Forms.Clipboard]::ContainsText()){
                $captureTextBox.SelectedText=[Windows.Forms.Clipboard]::GetText()
            }
        }catch{$hintLabel.Text='暂时无法读取剪贴板，可以直接输入。'}
    }.GetNewClosure())
    $captureForm.Controls.Add($pasteButton)
    $captureTextBox.Add_TextChanged({
        try{& $writeDraft $captureTextBox.Text $sendState.id $sendState.lastText}
        catch{$hintLabel.Text='暂时无法保存草稿，请保留此窗口。'}
    }.GetNewClosure())
    $saveButton.Add_Click({
        $draftRecorded=$false
        try{
            $value=([string]$captureTextBox.Text).Trim()
            if(-not $value){return}
            $saveButton.Enabled=$false
            if($sendState.lastText -and $sendState.lastText -ne $value){$sendState.id=[Guid]::NewGuid().ToString()}
            $sendState.lastText=$value
            & $writeDraft $captureTextBox.Text $sendState.id $sendState.lastText
            $draftRecorded=$true
            $status=Get-Content -LiteralPath (Join-Path $currentSettings.dataDir 'status.json') -Raw -Encoding UTF8|ConvertFrom-Json
            $key=[IO.File]::ReadAllText((Join-Path $currentSettings.dataDir 'admin.key')).Trim()
            $payload=@{id=$sendState.id;text=$value;source='windows-icon';createdAt=[DateTimeOffset]::Now.ToUnixTimeMilliseconds();attachments=@()}|ConvertTo-Json -Depth 6
            Invoke-RestMethod -Uri ($status.uiUrl+'/api/captures') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{Authorization=('Bearer '+$key);'X-Companion'='1'} -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 8|Out-Null
            $nextId=[Guid]::NewGuid().ToString()
            & $writeDraft '' $nextId $null
            $sendState.id=$nextId
            $sendState.lastText=$null
            $captureTextBox.Text=''
            $captureForm.Close()
        }catch{
            $hintLabel.Text=if($draftRecorded){'暂未完成登记，草稿已保留，可稍后重试。'}else{'本机草稿无法保存，请保留窗口或复制内容。'}
        }
        finally{if(-not $saveButton.IsDisposed){$saveButton.Enabled=$true}}
    }.GetNewClosure())
    $captureForm.Add_KeyDown({
        param($sender,$eventArgs)
        if($eventArgs.Control -and $eventArgs.KeyCode -eq [Windows.Forms.Keys]::Enter){
            $eventArgs.SuppressKeyPress=$true
            $saveButton.PerformClick()
        }elseif($eventArgs.KeyCode -eq [Windows.Forms.Keys]::Escape){$captureForm.Close()}
    }.GetNewClosure())
    $captureForm.Add_FormClosing({
        param($sender,$eventArgs)
        try{& $writeDraft $captureTextBox.Text $sendState.id $sendState.lastText}
        catch{
            $eventArgs.Cancel=$true
            $hintLabel.Text='草稿暂时无法保存，请保留窗口或复制内容。'
        }
    }.GetNewClosure())
    $captureForm.Add_Shown({
        if(-not $captureTextBox.IsDisposed){$captureTextBox.Focus()|Out-Null}
    }.GetNewClosure())
    $captureForm.Show()
    # A hidden PowerShell startup can suppress its first native window.
    $captureForm.Hide()
    $captureForm.Show()
    $captureForm.Activate()
}

$notify=New-Object Windows.Forms.NotifyIcon
$notify.Text='伴随 · 点一下记住'
$iconPath=Join-Path $settings.appRoot 'web/companion.ico'
if(Test-Path -LiteralPath $iconPath){$notify.Icon=New-Object Drawing.Icon($iconPath)}else{$notify.Icon=[Drawing.SystemIcons]::Application}
$menu=New-Object Windows.Forms.ContextMenuStrip
$captureItem=$menu.Items.Add('记一下')
$captureItem.Add_Click({Open-Capture})
$workbenchItem=$menu.Items.Add('打开工作台')
$workbenchItem.Add_Click({Open-Workbench})
$menu.Items.Add('-')|Out-Null
$quitItem=$menu.Items.Add('退出小图标')
$quitItem.Add_Click({
    if($script:captureForm -and -not $script:captureForm.IsDisposed){$script:captureForm.Close()}
    if(-not $script:captureForm -or $script:captureForm.IsDisposed){[Windows.Forms.Application]::Exit()}
})
$notify.ContextMenuStrip=$menu
$notify.Add_MouseClick({
    param($sender,$mouseEvent)
    if($mouseEvent.Button -eq [Windows.Forms.MouseButtons]::Left){Open-Capture}
})
$notify.Visible=$true
$requests=New-Object Windows.Forms.Timer
$requests.Interval=250
$requests.Add_Tick({
    if($stopRequest.WaitOne(0)){
        if($script:captureForm -and -not $script:captureForm.IsDisposed){$script:captureForm.Close()}
        if(-not $script:captureForm -or $script:captureForm.IsDisposed){[Windows.Forms.Application]::Exit()}
    }elseif($showRequest.WaitOne(0)){Open-Capture}
})
$requests.Start()
if($OpenCapture){$showRequest.Set()|Out-Null}
try{[Windows.Forms.Application]::Run()}
finally{
    $requests.Stop()
    $requests.Dispose()
    if($script:captureForm -and -not $script:captureForm.IsDisposed){$script:captureForm.Close()}
    $notify.Visible=$false
    $notify.Dispose()
    $showRequest.Dispose()
    $stopRequest.Dispose()
    $mutex.ReleaseMutex()
    $mutex.Dispose()
}
