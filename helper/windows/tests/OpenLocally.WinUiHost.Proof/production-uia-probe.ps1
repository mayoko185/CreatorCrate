param(
    [Parameter(Mandatory = $true)][long]$WindowHandle,
    [Parameter(Mandatory = $true)][string]$BodyName,
    [Parameter(Mandatory = $true)][string]$BodyTextBase64,
    [Parameter(Mandatory = $true)][string]$TitleExpected,
    [Parameter(Mandatory = $true)][long]$PostingActionHandle,
    [Parameter(Mandatory = $true)][string]$PostingActionName,
    [Parameter(Mandatory = $true)][string]$PostingExpectedEnabled,
    [string]$PostingExpectedVisible = 'true',
    [string]$PostingExpectedFocused = 'none',
    [string]$InvokePostingAction = 'false',
    [string]$VerifySharedButtons = 'false',
    [string]$VerifyTextEditors = 'true',
    [string]$TitleName = '',
    [string]$TitleTextBase64 = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$null = [System.Windows.Automation.AutomationElement]::RootElement
$frameworkDirectory = if ([Environment]::Is64BitProcess) { 'Framework64' } else { 'Framework' }
$providerPath = Join-Path $env:WINDIR (
    "Microsoft.NET\$frameworkDirectory\v4.0.30319\WPF\UIAutomationClientsideProviders.dll")
$providerAssembly = [Reflection.Assembly]::LoadFrom($providerPath)
$providerType = $providerAssembly.GetType(
    'UIAutomationClientsideProviders.UIAutomationClientSideProviders', $true)
$providerTable = $providerType.GetField('ClientSideProviderDescriptionTable').GetValue($null)
[System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($providerTable)

function Normalize-Text([string]$Value) {
    return $Value.Replace("`r`n", "`n").Replace("`r", "`n")
}

function Find-Edit([System.Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Edit)))
    return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Find-Button([System.Windows.Automation.AutomationElement]$Root, [string]$Name) {
    $condition = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $Name)),
        (New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button)))
    return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

function Assert-Editor(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Name,
    [string]$ExpectedText) {
    if ($null -eq $Element) { throw "UIA did not expose $Name." }
    $current = $Element.Current
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Edit -or
        $current.ClassName -ne 'RichEditBox' -or $current.Name -ne $Name -or
        -not $current.IsEnabled -or -not $current.IsKeyboardFocusable -or $current.IsOffscreen) {
        throw "Invalid UIA properties for $Name."
    }

    $textPattern = [System.Windows.Automation.TextPattern]$Element.GetCurrentPattern(
        [System.Windows.Automation.TextPattern]::Pattern)
    $actual = Normalize-Text $textPattern.DocumentRange.GetText(-1)
    $expected = Normalize-Text $ExpectedText
    if ($actual -eq "$expected`n") { $actual = $actual.Substring(0, $actual.Length - 1) }
    if ($expected -eq "$actual`n") { $expected = $expected.Substring(0, $expected.Length - 1) }
    if ($actual -cne $expected) {
        throw "TextPattern text differs for $Name; actual-length=$($actual.Length); expected-length=$($expected.Length)."
    }

    $readOnly = $textPattern.DocumentRange.GetAttributeValue(
        [System.Windows.Automation.TextPattern]::IsReadOnlyAttribute)
    if ($readOnly -isnot [bool] -or -not $readOnly) { throw "$Name is not read-only in UIA TextPattern." }

    $range = $textPattern.DocumentRange.Clone()
    $range.MoveEndpointByRange(
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
        $range,
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::Start)
    [void]$range.MoveEndpointByUnit(
        [System.Windows.Automation.Text.TextPatternRangeEndpoint]::End,
        [System.Windows.Automation.Text.TextUnit]::Character,
        1)
    $range.Select()
    $selected = $textPattern.GetSelection()
    if ($selected.Count -eq 0 -or ($selected | Where-Object { $_.GetText(-1).Length -gt 0 }).Count -eq 0) {
        throw "$Name did not expose its selection range."
    }

    $Element.SetFocus()
    $focused = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        if ($Element.Current.HasKeyboardFocus) { $focused = $true; break }
        Start-Sleep -Milliseconds 25
    }
    if (-not $focused) { throw "$Name did not receive keyboard focus through UIA." }

    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.SendKeys]::SendWait('z')
    [System.Windows.Forms.SendKeys]::SendWait('^v')
    Start-Sleep -Milliseconds 50
    $afterInput = Normalize-Text $textPattern.DocumentRange.GetText(-1)
    if ($afterInput -eq "$expected`n") { $afterInput = $afterInput.Substring(0, $afterInput.Length - 1) }
    if ($afterInput -cne $expected) { throw "Typing or paste mutated read-only content for $Name." }
    [System.Windows.Forms.SendKeys]::SendWait('^a')
    [System.Windows.Forms.SendKeys]::SendWait('+{LEFT}')
    [System.Windows.Forms.SendKeys]::SendWait('{RIGHT}')
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
    [System.Windows.Forms.SendKeys]::SendWait('{END}')
    [System.Windows.Forms.SendKeys]::SendWait('{PGUP}')
    [System.Windows.Forms.SendKeys]::SendWait('{PGDN}')
    Write-Output "uia=$Name; name=$Name; type=Edit; class=RichEditBox; text-pattern=true; read-only=true; selection-ranges=$($selected.Count); keyboard-focus=true; typing-paste-rejected=true; keyboard-navigation=true; code-units=$($expected.Length)"
}

function Assert-PostingButton(
    [System.Windows.Automation.AutomationElement]$Element,
    [string]$Name,
    [bool]$ExpectedEnabled,
    [string]$ExpectedFocused,
    [bool]$Invoke) {
    if ($null -eq $Element) {
        $named = $root.FindFirst(
            [System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty, $Name)))
        $direct = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($PostingActionHandle))
        $details = if ($null -eq $named) { 'no named element' } else {
            $patterns = ($named.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ','
            "named-type=$($named.Current.ControlType.ProgrammaticName); named-hwnd=$($named.Current.NativeWindowHandle); named-class=$($named.Current.ClassName); named-framework=$($named.Current.FrameworkId); named-provider=$($named.Current.ProviderDescription); named-focusable=$($named.Current.IsKeyboardFocusable); named-patterns=$patterns; direct-type=$($direct.Current.ControlType.ProgrammaticName); direct-provider=$($direct.Current.ProviderDescription)"
        }
        throw "UIA did not expose the required production posting Button HWND; $details."
    }
    $current = $Element.Current
    if ($current.NativeWindowHandle -eq 0 -or
        $current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or
        $current.Name -ne $Name -or $current.IsOffscreen -or
        $current.IsEnabled -ne $ExpectedEnabled) {
        throw "Invalid UIA posting Button properties for $Name; hwnd=$($current.NativeWindowHandle); type=$($current.ControlType.ProgrammaticName); name=$($current.Name); offscreen=$($current.IsOffscreen); enabled=$($current.IsEnabled); focusable=$($current.IsKeyboardFocusable)."
    }
    $invokePattern = $null
    if (-not $Element.TryGetCurrentPattern(
        [System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        throw "$Name does not expose InvokePattern."
    }
    if ($ExpectedEnabled) {
        if (-not $current.IsKeyboardFocusable) { throw "$Name is not keyboard focusable." }
    }
    if ($ExpectedFocused -ne 'none') {
        $expectedFocus = [bool]::Parse($ExpectedFocused)
        $focusMatched = $false
        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            if ($Element.Current.HasKeyboardFocus -eq $expectedFocus) { $focusMatched = $true; break }
            Start-Sleep -Milliseconds 25
        }
        if (-not $focusMatched) {
            $focusedElement = [System.Windows.Automation.AutomationElement]::FocusedElement
            throw "$Name exposed an incorrect HasKeyboardFocus state; focused-name=$($focusedElement.Current.Name); focused-hwnd=$($focusedElement.Current.NativeWindowHandle); focused-type=$($focusedElement.Current.ControlType.ProgrammaticName)."
        }
    }
    if ($Invoke) {
        ([System.Windows.Automation.InvokePattern]$invokePattern).Invoke()
        Write-Output "uia-invoke=$Name; dispatched=true"
    }
    Write-Output "uia=$Name; hwnd=$PostingActionHandle; type=Button; name=$Name; enabled=$ExpectedEnabled; keyboard-focusable=$($current.IsKeyboardFocusable); has-focus=$($Element.Current.HasKeyboardFocus); invoke-pattern=true"
}

function Assert-SharedButton([System.Windows.Automation.AutomationElement]$Element, [string]$Name) {
    if ($null -eq $Element) { throw "UIA did not expose the shared $Name Button." }
    $current = $Element.Current
    $invokePattern = $null
    if ($current.ControlType -ne [System.Windows.Automation.ControlType]::Button -or
        $current.Name -ne $Name -or -not $current.IsEnabled -or
        -not $current.IsKeyboardFocusable -or
        -not $Element.TryGetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokePattern)) {
        throw "Invalid UIA contract for shared $Name Button."
    }
    Write-Output "uia=$Name; type=Button; keyboard-focusable=true; invoke-pattern=true"
}

$root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($WindowHandle))
$posting = Find-Button $root $PostingActionName
$expectsPosting = [bool]::Parse($PostingExpectedVisible)
if ($expectsPosting) {
    Assert-PostingButton $posting $PostingActionName ([bool]::Parse($PostingExpectedEnabled)) `
        $PostingExpectedFocused ([bool]::Parse($InvokePostingAction))
}
elseif ($null -ne $posting -and -not $posting.Current.IsOffscreen) {
    throw 'UIA retained the posted action as a visible Button in Control view.'
}
if ([bool]::Parse($VerifySharedButtons)) {
    Assert-SharedButton (Find-Button $root 'Copy body') 'Copy body'
    Assert-SharedButton (Find-Button $root 'Close') 'Close'
}
if ([bool]::Parse($VerifyTextEditors)) {
    $title = Find-Edit $root 'Patreon title'
    $expectsTitle = [bool]::Parse($TitleExpected)
    if ($expectsTitle) {
        $titleText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleTextBase64))
        Assert-Editor $title $TitleName $titleText
    }
    elseif ($null -ne $title) {
        throw 'UIA exposed the hidden Patreon title in Control view.'
    }

    $bodyText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyTextBase64))
    Assert-Editor (Find-Edit $root $BodyName) $BodyName $bodyText
}
