# Notificación de Windows (silenciosa) + sonido. Título y texto llegan por CC_TITLE / CC_TEXT.
# Requiere Windows PowerShell 5.1 (pwsh 7 no carga los tipos WinRT).
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
[void]$x.GetElementsByTagName('text').Item(0).AppendChild($x.CreateTextNode($env:CC_TITLE))
[void]$x.GetElementsByTagName('text').Item(1).AppendChild($x.CreateTextNode($env:CC_TEXT))
$a = $x.CreateElement('audio'); $a.SetAttribute('silent', 'true'); [void]$x.DocumentElement.AppendChild($a)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))
(New-Object Media.SoundPlayer "$env:WINDIR\Media\Windows Notify Calendar.wav").PlaySync()
