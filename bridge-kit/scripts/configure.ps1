$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bridgeRoot = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $bridgeRoot 'config.local.json'
if (-not (Test-Path -LiteralPath $configFile)) { [Windows.Forms.MessageBox]::Show('请先把安装包交给 Codex 桌面端并说：安装这个飞书桥接插件。首次安装完成后，可直接双击配置。') | Out-Null; exit 1 }
$cfg = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$form = New-Object Windows.Forms.Form
$form.Text = 'Codex 飞书桥接配置'
$form.Size = New-Object Drawing.Size(620,310)
$form.StartPosition = 'CenterScreen'
$idLabel = New-Object Windows.Forms.Label
$idLabel.Text = '飞书 App ID'; $idLabel.Location = New-Object Drawing.Point(20,25); $idLabel.Width = 150
$idBox = New-Object Windows.Forms.TextBox
$idBox.Location = New-Object Drawing.Point(170,22); $idBox.Width = 400; $idBox.Text = $cfg.feishu.appId
$secretLabel = New-Object Windows.Forms.Label
$secretLabel.Text = 'App Secret（留空保留）'; $secretLabel.Location = New-Object Drawing.Point(20,70); $secretLabel.Width = 150
$secretBox = New-Object Windows.Forms.TextBox
$secretBox.Location = New-Object Drawing.Point(170,67); $secretBox.Width = 400; $secretBox.UseSystemPasswordChar = $true
$note = New-Object Windows.Forms.Label
$note.Location = New-Object Drawing.Point(20,115); $note.Size = New-Object Drawing.Size(560,70)
$note.Text = '需要：已登录的 Codex 桌面端、飞书自建应用机器人和消息权限。保存后请重启桥接。密钥使用当前 Windows 账号加密；首次绑定请向机器人私聊发送本机生成的配对码。'
$save = New-Object Windows.Forms.Button
$save.Text = '保存'; $save.Location = New-Object Drawing.Point(455,205); $save.Width = 115
$save.Add_Click({
  try {
    if ($idBox.Text.Trim() -notmatch '^cli_[A-Za-z0-9]+$') { throw 'App ID 格式不正确' }
    $cfg.feishu.appId = $idBox.Text.Trim()
    if ($secretBox.Text) {
      $secretBox.Text.Trim() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath (Join-Path $bridgeRoot $cfg.feishu.secretFile)
    }
    $cfg | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $configFile -Encoding UTF8
    [Windows.Forms.MessageBox]::Show('已保存。请关闭配置窗口后运行 start.cmd。') | Out-Null
    $form.Close()
  } catch { [Windows.Forms.MessageBox]::Show($_.Exception.Message) | Out-Null }
})
$form.Controls.AddRange(@($idLabel,$idBox,$secretLabel,$secretBox,$note,$save))
[void]$form.ShowDialog()
