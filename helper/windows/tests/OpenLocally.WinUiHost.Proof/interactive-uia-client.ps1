param(
    [Parameter(Mandatory = $true)][long]$WindowHandle,
    [Parameter(Mandatory = $true)]
    [ValidateSet('ready-focus', 'richedit-enter', 'invoke', 'assert-invoke', 'disabled-invoke', 'assert-absent')]
    [string]$Operation,
    [Parameter(Mandatory = $true)][string]$PostingName,
    [Parameter(Mandatory = $true)][string]$BodyName,
    [Parameter(Mandatory = $true)][string]$ExpectedBodyBase64
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$null = [System.Windows.Automation.AutomationElement]::RootElement

$frameworkDirectory = if ([Environment]::Is64BitProcess) { 'Framework64' } else { 'Framework' }
$providerPath = Join-Path $env:WINDIR (
    "Microsoft.NET\$frameworkDirectory\v4.0.30319\WPF\UIAutomationClientsideProviders.dll")
if (-not (Test-Path -LiteralPath $providerPath -PathType Leaf)) {
    throw "UIAutomationClientsideProviders.dll was not found at the expected Windows framework path."
}
$providerAssembly = [Reflection.Assembly]::LoadFrom($providerPath)
$providerType = $providerAssembly.GetType(
    'UIAutomationClientsideProviders.UIAutomationClientSideProviders', $true)
$providerTable = $providerType.GetField('ClientSideProviderDescriptionTable').GetValue($null)
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($providerTable)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Wp10cNative {
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
'@

function Find-Control([System.Windows.Automation.AutomationElement]$Root, [string]$Name, $ControlType) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlType)))
    return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Wait-For([scriptblock]$Condition, [string]$Failure) {
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if (& $Condition) { return }
        Start-Sleep -Milliseconds 25
    }
    throw $Failure
}

function Assert-Button($Element, [string]$Name, [bool]$Enabled, [bool]$RequireFocusable = $true) {
    if ($null -eq $Element) { throw "UIA did not expose the '$Name' Button." }
    $current = $Element.Current
    $pattern = $null
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or
        $current.Name -cne $Name -or $current.IsEnabled -ne $Enabled -or $current.IsOffscreen -or
        ($RequireFocusable -and -not $current.IsKeyboardFocusable) -or
        -not $Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
        throw "Invalid '$Name' Button: type=$($current.ControlType.ProgrammaticName); name=$($current.Name); enabled=$($current.IsEnabled); focusable=$($current.IsKeyboardFocusable); offscreen=$($current.IsOffscreen); provider=$($current.ProviderDescription)."
    }
    return [System.Windows.Automation.InvokePattern]$pattern
}

function Foreground-Diagnostics([IntPtr]$Handle) {
    [uint32]$processId = 0
    [void][Wp10cNative]::GetWindowThreadProcessId($Handle, [ref]$processId)
    $class = New-Object Text.StringBuilder 128
    $title = New-Object Text.StringBuilder 256
    [void][Wp10cNative]::GetClassName($Handle, $class, $class.Capacity)
    [void][Wp10cNative]::GetWindowText($Handle, $title, $title.Capacity)
    return "hwnd=0x$($Handle.ToInt64().ToString('X')); pid=$processId; class=$class; title=$title"
}

$handle = [IntPtr]::new($WindowHandle)
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if ($null -eq $root) { throw 'UIA could not create an element for the production companion HWND.' }

if ($Operation -eq 'ready-focus') {
    [void][Wp10cNative]::ShowWindowAsync($handle, 9)
    if (-not [Wp10cNative]::SetForegroundWindow($handle)) {
        throw 'Supported SetForegroundWindow activation was rejected by Windows.'
    }
    Wait-For { [Wp10cNative]::GetForegroundWindow() -eq $handle } `
        'The production companion did not become the foreground window.'
    $foreground = [Wp10cNative]::GetForegroundWindow()
    Write-Output "foreground=$(Foreground-Diagnostics $foreground)"

    $posting = Find-Control $root $PostingName ([System.Windows.Automation.ControlType]::Button)
    [void](Assert-Button $posting $PostingName $true)
    $posting.SetFocus()
    Wait-For { $posting.Current.HasKeyboardFocus } "'$PostingName' did not receive keyboard focus."
    if (-not $posting.Current.IsKeyboardFocusable) { throw "'$PostingName' stopped being keyboard focusable." }

    $copy = Find-Control $root 'Copy body' ([System.Windows.Automation.ControlType]::Button)
    [void](Assert-Button $copy 'Copy body' $true)
    $close = Find-Control $root 'Close' ([System.Windows.Automation.ControlType]::Button)
    [void](Assert-Button $close 'Close' $true)
    $close.SetFocus()
    Wait-For { $close.Current.HasKeyboardFocus -and -not $posting.Current.HasKeyboardFocus } `
        "Focus did not move away from '$PostingName'."
    Write-Output "uia-ready=Button; name=$PostingName; enabled=true; keyboard-focusable=true; invoke-pattern=true; focus-observed=true; focus-moved-away=true"
    Write-Output 'uia-shared=Copy body,Close; type=Button; useful-name=true; invoke-pattern=true'
    exit 0
}

if ($Operation -eq 'richedit-enter') {
    $body = Find-Control $root $BodyName ([System.Windows.Automation.ControlType]::Edit)
    if ($null -eq $body -or $body.Current.ClassName -ne 'RichEditBox') {
        throw "UIA did not expose the real '$BodyName' RichEditBox."
    }
    $expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExpectedBodyBase64))
    $textPattern = [System.Windows.Automation.TextPattern]$body.GetCurrentPattern(
        [System.Windows.Automation.TextPattern]::Pattern)
    $before = $textPattern.DocumentRange.GetText(-1).TrimEnd([char[]]"`r`n")
    if ($before -cne $expected.TrimEnd([char[]]"`r`n")) { throw 'RichEditBox fixture text differed before Enter.' }
    $body.SetFocus()
    Wait-For { $body.Current.HasKeyboardFocus } "'$BodyName' did not receive keyboard focus."
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Start-Sleep -Milliseconds 150
    Write-Output 'richedit-enter=ordinary-keyboard; focused=true; dispatched=true'
    exit 0
}

$posting = Find-Control $root $PostingName ([System.Windows.Automation.ControlType]::Button)
if ($Operation -eq 'assert-absent') {
    if ($null -ne $posting -and
        (-not $posting.Current.IsOffscreen -or $posting.Current.IsKeyboardFocusable -or
            $posting.Current.HasKeyboardFocus)) {
        throw "UIA retained a visible or focusable '$PostingName' Button after canonical Posted state."
    }
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -ne $focused -and $focused.Current.Name -ceq $PostingName) {
        throw "UIA retained phantom focus on '$PostingName'."
    }
    Write-Output "uia-absent=$PostingName; visible=false; phantom-focus=false"
    exit 0
}

if ($Operation -eq 'disabled-invoke') {
    $invoke = Assert-Button $posting $PostingName $false $false
    $behavior = 'returned-without-exception'
    try { $invoke.Invoke() }
    catch { $behavior = "exception=$($_.Exception.GetType().FullName); hresult=0x$($_.Exception.HResult.ToString('X8'))" }
    Write-Output "uia-disabled=$PostingName; type=Button; enabled=false; invoke-attempt=$behavior"
    exit 0
}

$invoke = Assert-Button $posting $PostingName $true
$invoke.Invoke()
Write-Output "uia-invoke=$PostingName; actual-InvokePattern.Invoke=true"
