param([Parameter(Mandatory=$true)][string]$Manifest)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$synthType = [Windows.Media.SpeechSynthesis.SpeechSynthesizer,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
$streamType = [Windows.Media.SpeechSynthesis.SpeechSynthesisStream,Windows.Media.SpeechSynthesis,ContentType=WindowsRuntime]
$synth = New-Object $synthType.FullName
$voice = $synthType::AllVoices | Where-Object Language -Like 'zh*' | Select-Object -First 1
if (-not $voice) { throw 'Install a Chinese Windows speech voice for local rendering.' }
$synth.Voice = $voice
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetGenericArguments().Count -eq 1 -and
  $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name.StartsWith('IAsyncOperation')
} | Select-Object -First 1
try {
  foreach ($entry in (Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json)) {
    $operation = $synth.SynthesizeTextToStreamAsync([string]$entry.text)
    $task = $asTask.MakeGenericMethod($streamType).Invoke($null,@($operation))
    $stream = $task.GetAwaiter().GetResult()
    $audioInput = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream.GetInputStreamAt(0))
    $out = [System.IO.File]::Create($entry.file)
    try { $audioInput.CopyTo($out) } finally { $out.Dispose(); $audioInput.Dispose(); $stream.Dispose() }
  }
} finally { $synth.Dispose() }
