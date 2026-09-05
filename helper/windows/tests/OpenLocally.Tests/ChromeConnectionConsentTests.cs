using OpenLocally;
using System.Reflection;
using System.Runtime.InteropServices;

namespace OpenLocally.Tests;

public class ChromeConnectionConsentTests
{
    [Fact]
    public void DesktopAttachmentFailureDoesNotCallEitherVisibleStyleDialog()
    {
        var native = new RecordingConsentNativeOperations();
        var consent = new NativeChromeConnectionConsent(native, () => new FailedDesktop());
        Assert.Equal(ChromeConnectionConsentDecision.DisplayFailed, consent.ConfirmReady());
        Assert.Equal(0, native.TaskDialogCalls);
        Assert.Equal(0, native.CustomDialogCalls);
        Assert.Empty(native.Events);
        Assert.Equal(170, consent.LastPresentation!.Win32Code);
        Assert.False(consent.LastPresentation.ThreadDesktopSelected);
    }

    private sealed class FailedDesktop : NativeOperatorUiHost.Native
    {
        public override int LastError => 170;
        public override bool Execute(NativePresentationStage stage, NativePresentationResult result)
            => stage == NativePresentationStage.open_input_desktop;
    }

    [Fact]
    public void ReadyPrompt_ExposesContinueAndCancelWithoutStockButtonLegend()
    {
        ChromeConnectionConsentPrompt prompt = NativeChromeConnectionConsent.ReadyPrompt;

        Assert.Equal("Ready to connect to Chrome?", prompt.Instruction);
        Assert.Equal(["Continue", "Cancel"], prompt.ButtonLabels);
        Assert.Contains("Remote Debugging approval prompt", prompt.Content);
        Assert.DoesNotContain("Yes:", prompt.Content);
        Assert.DoesNotContain("No:", prompt.Content);
    }

    [Fact]
    public void RetryPrompt_ExposesRetryAndCancelWithoutStockButtonLegend()
    {
        ChromeConnectionConsentPrompt prompt = NativeChromeConnectionConsent.CreateRetryPrompt();

        Assert.Equal("Chrome connection wasn't completed.", prompt.Instruction);
        Assert.Equal(["Retry", "Cancel"], prompt.ButtonLabels);
        Assert.Contains("previous approval attempt ended without establishing a connection", prompt.Content);
        Assert.DoesNotContain("Yes:", prompt.Content);
        Assert.DoesNotContain("No:", prompt.Content);
    }

    [Theory]
    [InlineData(false, "Ready to connect to Chrome?", "Continue")]
    [InlineData(true, "Chrome connection wasn't completed.", "Retry")]
    public void NativeFallbackModel_PreservesTheCompletePromptTitleAndButtons(bool retry, string expectedTitle, string expectedConfirmLabel)
    {
        ChromeConnectionConsentPrompt prompt = retry
            ? NativeChromeConnectionConsent.CreateRetryPrompt()
            : NativeChromeConnectionConsent.ReadyPrompt;

        NativeConsentDialogModel model = NativeConsentWindow.CreateModel(prompt);

        Assert.Equal(expectedTitle, model.Title);
        Assert.Equal(prompt.Content, model.Message);
        Assert.Equal([expectedConfirmLabel, "Cancel"], model.ButtonLabels);
    }

    [Fact]
    public void TaskDialogImport_UsesTheExactNonSuffixedNativeEntryPoint()
    {
        MethodInfo method = typeof(NativeChromeConnectionConsent)
            .GetMethod("TaskDialogIndirect", BindingFlags.NonPublic | BindingFlags.Static)!;
        DllImportAttribute import = method.GetCustomAttribute<DllImportAttribute>()!;

        Assert.True(import.ExactSpelling);
    }

    [Fact]
    public void NativeFallbackWindowImport_UsesTheExplicitWideEntryPoint()
    {
        MethodInfo method = typeof(NativeConsentWindow)
            .GetMethod("CreateWindowExW", BindingFlags.NonPublic | BindingFlags.Static)!;
        DllImportAttribute import = method.GetCustomAttribute<DllImportAttribute>()!;

        Assert.Equal("CreateWindowExW", import.EntryPoint);
        Assert.Equal(CharSet.Unicode, import.CharSet);
        Assert.True(import.ExactSpelling);
    }

    [Theory]
    [InlineData("RegisterClassW")]
    [InlineData("DefWindowProcW")]
    public void NativeFallbackTitleImports_UseExplicitWideEntryPoints(string methodName)
    {
        MethodInfo method = typeof(NativeConsentWindow)
            .GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        DllImportAttribute import = method.GetCustomAttribute<DllImportAttribute>()!;

        Assert.Equal(methodName, import.EntryPoint);
        Assert.Equal(CharSet.Unicode, import.CharSet);
        Assert.True(import.ExactSpelling);
    }

    [Theory]
    [InlineData(100, ChromeConnectionConsentDecision.Continue)]
    [InlineData(101, ChromeConnectionConsentDecision.Cancel)]
    [InlineData(2, ChromeConnectionConsentDecision.Cancel)]
    [InlineData(0, ChromeConnectionConsentDecision.DisplayFailed)]
    public void SelectedButton_MapsToTypedConsentDecision(int selectedButton, ChromeConnectionConsentDecision expected)
    {
        Assert.Equal(expected, NativeChromeConnectionConsent.MapSelectedButton(selectedButton));
    }

    [Theory]
    [InlineData(ChromeConnectionConsentDecision.Continue)]
    [InlineData(ChromeConnectionConsentDecision.Cancel)]
    public void ActivationContextCreationFailure_UsesCustomFallbackResult(ChromeConnectionConsentDecision fallbackDecision)
    {
        var native = new RecordingConsentNativeOperations
        {
            Creation = new(false, new IntPtr(-1), 14001),
            CustomDecision = fallbackDecision,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmReady();

        Assert.Equal(fallbackDecision, result);
        Assert.Equal(0, native.TaskDialogCalls);
        Assert.Equal(1, native.CustomDialogCalls);
        Assert.Equal(["create", "custom"], native.Events);
        Assert.Contains("activationContext=CreateActCtxFailed:14001", consent.LastNativeDiagnostic);
    }

    [Fact]
    public void ActivationContextActivationFailure_ReleasesPartialContextBeforeCustomFallback()
    {
        var native = new RecordingConsentNativeOperations
        {
            Activation = new(false, 0, 5),
            CustomDecision = ChromeConnectionConsentDecision.Continue,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmReady();

        Assert.Equal(ChromeConnectionConsentDecision.Continue, result);
        Assert.Equal(0, native.TaskDialogCalls);
        Assert.Equal(["create", "activate", "release", "custom"], native.Events);
        Assert.DoesNotContain("deactivate", native.Events);
        Assert.Contains("activationContext=ActivateActCtxFailed:5", consent.LastNativeDiagnostic);
    }

    [Fact]
    public void TaskDialogHResultFailure_UnwindsActivationBeforeCustomFallback()
    {
        var native = new RecordingConsentNativeOperations
        {
            TaskDialogResult = new(unchecked((int)0x80070057), 0),
            CustomDecision = ChromeConnectionConsentDecision.Continue,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmRetry("chrome_connection_failed");

        Assert.Equal(ChromeConnectionConsentDecision.Continue, result);
        Assert.Equal(["create", "activate", "taskDialog", "deactivate", "release", "custom"], native.Events);
        Assert.Contains("taskDialogHResult=0x80070057", consent.LastNativeDiagnostic);
    }

    [Fact]
    public void TaskDialogEntryFailure_UnwindsActivationBeforeCustomFallback()
    {
        var native = new RecordingConsentNativeOperations
        {
            TaskDialogResult = new(-1, 0, nameof(EntryPointNotFoundException)),
            CustomDecision = ChromeConnectionConsentDecision.Continue,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmReady();

        Assert.Equal(ChromeConnectionConsentDecision.Continue, result);
        Assert.Equal(["create", "activate", "taskDialog", "deactivate", "release", "custom"], native.Events);
        Assert.Contains("taskDialogException=EntryPointNotFoundException", consent.LastNativeDiagnostic);
    }

    [Fact]
    public void TaskDialogUnavailableAndCustomDialogFailure_ReturnsDisplayFailed()
    {
        var native = new RecordingConsentNativeOperations
        {
            TaskDialogResult = new(unchecked((int)0x80070057), 0),
            CustomDecision = ChromeConnectionConsentDecision.DisplayFailed,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmReady();

        Assert.Equal(ChromeConnectionConsentDecision.DisplayFailed, result);
        Assert.Equal(1, native.CustomDialogCalls);
        Assert.Equal(["create", "activate", "taskDialog", "deactivate", "release", "custom"], native.Events);
        Assert.Contains("customDialog=test", consent.LastNativeDiagnostic);
    }

    [Fact]
    public void CustomFallbackCancel_PreservesOperatorCancellation()
    {
        var native = new RecordingConsentNativeOperations
        {
            Activation = new(false, 0, 5),
            CustomDecision = ChromeConnectionConsentDecision.Cancel,
        };
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmRetry("chrome_connection_failed");

        Assert.Equal(ChromeConnectionConsentDecision.Cancel, result);
    }

    [Fact]
    public void SuccessfulTaskDialog_PreservesItsResultWithoutUsingFallback()
    {
        var native = new RecordingConsentNativeOperations();
        var consent = new NativeChromeConnectionConsent(native, () => new AttachedTestDesktop());

        ChromeConnectionConsentDecision result = consent.ConfirmReady();

        Assert.Equal(ChromeConnectionConsentDecision.Continue, result);
        Assert.Equal(0, native.CustomDialogCalls);
        Assert.Equal(["create", "activate", "taskDialog", "deactivate", "release"], native.Events);
    }

    private sealed class RecordingConsentNativeOperations : IChromeConsentNativeOperations
    {
        public ActivationContextCreation Creation { get; init; } = new(true, new IntPtr(123), 0);
        public ActivationContextActivation Activation { get; init; } = new(true, 456, 0);
        public TaskDialogDisplayResult TaskDialogResult { get; init; } = new(0, 100);
        public ChromeConnectionConsentDecision CustomDecision { get; init; } = ChromeConnectionConsentDecision.Continue;
        public List<string> Events { get; } = [];
        public int TaskDialogCalls { get; private set; }
        public int CustomDialogCalls { get; private set; }

        public ActivationContextCreation CreateActivationContext(string manifestPath)
        {
            Events.Add("create");
            return Creation;
        }

        public ActivationContextActivation ActivateActivationContext(IntPtr activationContext)
        {
            Events.Add("activate");
            return Activation;
        }

        public void DeactivateActivationContext(nuint activationCookie) => Events.Add("deactivate");

        public void ReleaseActivationContext(IntPtr activationContext) => Events.Add("release");

        public IntPtr GetForegroundWindow() => new(42);

        public bool IsWindow(IntPtr window) => true;

        public TaskDialogDisplayResult ShowTaskDialog(ChromeConnectionConsentPrompt prompt, IntPtr owner)
        {
            Events.Add("taskDialog");
            TaskDialogCalls++;
            return TaskDialogResult;
        }

        public ChromeConnectionConsentDecision ShowCustomDialog(
            ChromeConnectionConsentPrompt prompt,
            IntPtr owner,
            out string diagnostic)
        {
            Events.Add("custom");
            CustomDialogCalls++;
            diagnostic = "customDialog=test";
            return CustomDecision;
        }
    }
}
