$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ownsMutex=$false
$mutex=[Threading.Mutex]::new($false,'Local\CompanionMVPTray')
try{$ownsMutex=$mutex.WaitOne(0,$false)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
if(-not $ownsMutex){$mutex.Dispose();exit}
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
    if($script:captureForm -and -not $script:captureForm.IsDisposed){$script:captureForm.Activate();return}
    $form=New-Object Windows.Forms.Form
    $currentSettings=$settings
    $draftPath=$script:draftPath
    $currentEncoding=$utf8
    $sendState=@{id=[Guid]::NewGuid().ToString();lastText=$null}
    $draftText=''
    if(Test-Path -LiteralPath $draftPath){try{$draftData=Get-Content -LiteralPath $draftPath -Raw -Encoding UTF8|ConvertFrom-Json;$draftText=$draftData.text;if($draftData.id){$sendState.id=$draftData.id};$sendState.lastText=$draftData.lastText}catch{$draftText=[IO.File]::ReadAllText($draftPath)}}
    $script:captureForm=$form
    $form.Text='记一下'
    $form.Size=New-Object Drawing.Size(470,335)
    $form.MinimumSize=New-Object Drawing.Size(390,290)
    $form.StartPosition='CenterScreen'
    $form.TopMost=$true
    $form.Font=New-Object Drawing.Font('Microsoft YaHei UI',10)
    $form.BackColor=[Drawing.Color]::FromArgb(247,248,245)
    $form.KeyPreview=$true
    $label=New-Object Windows.Forms.Label
    $label.Text='留住这一点，之后接着用。'
    $label.Location=New-Object Drawing.Point(18,15)
    $label.AutoSize=$true
    $form.Controls.Add($label)
    $input=New-Object Windows.Forms.TextBox
    $input.Multiline=$true;$input.AcceptsReturn=$true;$input.ScrollBars='Vertical';$input.MaxLength=20000
    $input.Location=New-Object Drawing.Point(18,46);$input.Size=New-Object Drawing.Size(417,170);$input.Anchor='Top,Left,Right,Bottom'
    $input.Text=$draftText
    $form.Controls.Add($input)
    $hint=New-Object Windows.Forms.Label
    $hint.Text='先登记，不会自动派活。'
    $hint.Location=New-Object Drawing.Point(18,225);$hint.Size=New-Object Drawing.Size(410,28);$hint.Anchor='Left,Right,Bottom'
    $hint.ForeColor=[Drawing.Color]::FromArgb(100,117,105);$form.Controls.Add($hint)
    $save=New-Object Windows.Forms.Button
    $save.Text='记下 · Ctrl+Enter';$save.Size=New-Object Drawing.Size(160,34);$save.Location=New-Object Drawing.Point(275,260);$save.Anchor='Right,Bottom'
    $save.BackColor=[Drawing.Color]::FromArgb(49,91,61);$save.ForeColor=[Drawing.Color]::White;$save.FlatStyle='Flat';$form.Controls.Add($save)
    $paste=New-Object Windows.Forms.Button
    $paste.Text='粘贴';$paste.Size=New-Object Drawing.Size(72,34);$paste.Location=New-Object Drawing.Point(18,260);$paste.Anchor='Left,Bottom'
    $paste.Add_Click({if([Windows.Forms.Clipboard]::ContainsText()){$input.SelectedText=[Windows.Forms.Clipboard]::GetText()}}.GetNewClosure());$form.Controls.Add($paste)
    $save.Add_Click({
        if(-not $input.Text.Trim()){return}
        $save.Enabled=$false
        try{
            $value=$input.Text.Trim()
            if($sendState.lastText -and $sendState.lastText -ne $value){$sendState.id=[Guid]::NewGuid().ToString()}
            $sendState.lastText=$value
            $status=Get-Content -LiteralPath (Join-Path $currentSettings.dataDir 'status.json') -Raw -Encoding UTF8|ConvertFrom-Json
            $key=[IO.File]::ReadAllText((Join-Path $currentSettings.dataDir 'admin.key')).Trim()
            $payload=@{id=$sendState.id;text=$value;source='windows-icon';createdAt=[DateTimeOffset]::Now.ToUnixTimeMilliseconds();attachments=@()}|ConvertTo-Json -Depth 6
            Invoke-RestMethod -Uri ($status.uiUrl+'/api/captures') -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{Authorization=('Bearer '+$key);'X-Companion'='1'} -Body ([Text.Encoding]::UTF8.GetBytes($payload)) -TimeoutSec 8|Out-Null
            $sendState.id=[Guid]::NewGuid().ToString();$sendState.lastText=$null;$input.Text='';$form.Close()
        }catch{$hint.Text='暂未送到工作台，草稿会留在本机，可稍后重试。'}
        finally{$save.Enabled=$true}
    }.GetNewClosure())
    $form.Add_KeyDown({param($sender,$eventArgs)if($eventArgs.Control -and $eventArgs.KeyCode -eq [Windows.Forms.Keys]::Enter){$eventArgs.SuppressKeyPress=$true;$save.PerformClick()}elseif($eventArgs.KeyCode -eq [Windows.Forms.Keys]::Escape){$form.Close()}}.GetNewClosure())
    $form.Add_FormClosing({$value=@{id=$sendState.id;text=$input.Text;lastText=$sendState.lastText}|ConvertTo-Json;[IO.File]::WriteAllText($draftPath,$value,$currentEncoding)}.GetNewClosure())
    $form.Add_Shown({$input.Focus()}.GetNewClosure())
    $form.Show()
}

$notify=New-Object Windows.Forms.NotifyIcon
$notify.Text='伴随 · 点一下记住'
$iconPath=Join-Path $settings.appRoot 'web/companion.ico'
if(Test-Path -LiteralPath $iconPath){$notify.Icon=New-Object Drawing.Icon($iconPath)}else{$notify.Icon=[Drawing.SystemIcons]::Application}
$menu=New-Object Windows.Forms.ContextMenuStrip
$captureItem=$menu.Items.Add('记一下');$captureItem.Add_Click({Open-Capture})
$workbenchItem=$menu.Items.Add('打开工作台');$workbenchItem.Add_Click({Open-Workbench})
$menu.Items.Add('-')|Out-Null
$quitItem=$menu.Items.Add('退出小图标');$quitItem.Add_Click({[Windows.Forms.Application]::Exit()})
$notify.ContextMenuStrip=$menu
$notify.Add_MouseClick({param($sender,$mouseEvent)if($mouseEvent.Button -eq [Windows.Forms.MouseButtons]::Left){Open-Capture}})
$notify.Visible=$true
try{[Windows.Forms.Application]::Run()}finally{$notify.Visible=$false;$notify.Dispose();if($script:captureForm -and -not $script:captureForm.IsDisposed){$script:captureForm.Close()};$mutex.ReleaseMutex();$mutex.Dispose()}
