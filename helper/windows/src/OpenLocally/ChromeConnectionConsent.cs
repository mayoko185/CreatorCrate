using System.Runtime.InteropServices;

namespace OpenLocally;

/// <summary>
/// Run-scoped operator decisions for Chrome's native Remote Debugging consent.
/// The prompt is deliberately separate from the five-minute socket approval window.
/// </summary>
public enum ChromeConnectionConsentDecision
{
    Continue,
    Cancel,
    DisplayFailed,
}

public interface IChromeConnectionConsent
{
    ChromeConnectionConsentDecision ConfirmReady();

    ChromeConnectionConsentDecision ConfirmRetry(string errorCode);
}

internal sealed record ChromeConnectionConsentPrompt(
    string Instruction,
    string Content,
    string ConfirmLabel)
{
    internal const string CancelLabel = "Cancel";

    internal IReadOnlyList<string> ButtonLabels => [ConfirmLabel, CancelLabel];
}

internal sealed record NativeConsentDialogModel(
    string Title,
    string Message,
    string ConfirmLabel,
    string CancelLabel)
{
    internal IReadOnlyList<string> ButtonLabels => [ConfirmLabel, CancelLabel];
}

internal readonly record struct ActivationContextCreation(bool Succeeded, IntPtr Handle, int Error);

internal readonly record struct ActivationContextActivation(bool Succeeded, nuint Cookie, int Error);

internal readonly record struct TaskDialogDisplayResult(int HResult, int SelectedButton, string? ExceptionName = null);

internal interface IChromeConsentNativeOperations
{
    ActivationContextCreation CreateActivationContext(string manifestPath);

    ActivationContextActivation ActivateActivationContext(IntPtr activationContext);

    void DeactivateActivationContext(nuint activationCookie);

    void ReleaseActivationContext(IntPtr activationContext);

    IntPtr GetForegroundWindow();

    bool IsWindow(IntPtr window);

    TaskDialogDisplayResult ShowTaskDialog(ChromeConnectionConsentPrompt prompt, IntPtr owner);

    ChromeConnectionConsentDecision ShowCustomDialog(ChromeConnectionConsentPrompt prompt, IntPtr owner, out string diagnostic);
}

public sealed class NativeChromeConnectionConsent : IChromeConnectionConsent, IChromeConsentNativeOperations
{
    private const int ConfirmButton = 100;
    private const int CancelButton = 101;
    private const int NativeCancelButton = 2;
    private const uint AllowDialogCancellation = 0x0008;
    private const uint PositionRelativeToOwner = 0x1000;
    private const uint SetForeground = 0x00010000;
    private const string CommonControlsManifestFileName = "OpenLocally.CommonControls.manifest";
    private static readonly IntPtr InvalidActivationContext = new(-1);
    private readonly IChromeConsentNativeOperations nativeOperations;
    private readonly Func<NativeOperatorUiHost.Native> hostNative;
    private readonly CancellationToken cancellation;
    private NativePresentationResult? activePresentation;

    public NativeChromeConnectionConsent()
    {
        nativeOperations = this;
        hostNative = () => new NativeOperatorUiHost.Native();
    }

    internal NativeChromeConnectionConsent(CancellationToken cancellation) : this() { this.cancellation = cancellation; }

    internal NativeChromeConnectionConsent(IChromeConsentNativeOperations nativeOperations, Func<NativeOperatorUiHost.Native>? hostNative = null)
    {
        this.nativeOperations = nativeOperations ?? throw new ArgumentNullException(nameof(nativeOperations));
        this.hostNative = hostNative ?? (() => new NativeOperatorUiHost.Native());
    }

    internal static ChromeConnectionConsentPrompt ReadyPrompt { get; } = new(
        "Ready to connect to Chrome?",
        "Chrome will display a Remote Debugging approval prompt.\n\nWhen you are ready to click Allow in Chrome, choose Continue.",
        "Continue");

    internal string LastNativeDiagnostic { get; private set; } = "not_invoked";
    public NativePresentationResult? LastPresentation { get; private set; }

    public ChromeConnectionConsentDecision ConfirmReady() => Confirm(ReadyPrompt);

    internal static ChromeConnectionConsentPrompt CreateRetryPrompt() => new(
        "Chrome connection wasn't completed.",
        "The previous approval attempt ended without establishing a connection.\n\nWhen you are ready for Chrome to show the approval prompt again, choose Retry.",
        "Retry");

    public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) => Confirm(CreateRetryPrompt());

    internal static ChromeConnectionConsentDecision MapSelectedButton(int selectedButton) => selectedButton switch
    {
        ConfirmButton => ChromeConnectionConsentDecision.Continue,
        CancelButton or NativeCancelButton => ChromeConnectionConsentDecision.Cancel,
        _ => ChromeConnectionConsentDecision.DisplayFailed,
    };

    private ChromeConnectionConsentDecision Confirm(ChromeConnectionConsentPrompt prompt)
    {
        var decision = ChromeConnectionConsentDecision.DisplayFailed;
        LastPresentation = NativeOperatorUiHost.Show(hostNative(), result =>
        {
            activePresentation = result;
            result.Stage = NativePresentationStage.create_main_window;
            decision = ConfirmAttached(prompt);
            if (decision is ChromeConnectionConsentDecision.Continue or ChromeConnectionConsentDecision.Cancel)
            {
                result.NormalDismissal = true;
                result.State = NativePresentationState.PresentedAndDismissed;
                result.Stage = NativePresentationStage.completed;
            }
        }, cancellation);
        activePresentation = null;
        return LastPresentation.State == NativePresentationState.PresentedAndDismissed
            ? decision : ChromeConnectionConsentDecision.DisplayFailed;
    }

    private ChromeConnectionConsentDecision ConfirmAttached(ChromeConnectionConsentPrompt prompt)
    {
        string manifestPath = Path.Combine(AppContext.BaseDirectory, CommonControlsManifestFileName);
        string host = Path.GetFileName(Environment.ProcessPath) ?? "unknown";
        IntPtr owner = nativeOperations.GetForegroundWindow();
        if (!TryActivateCommonControls(manifestPath, out IntPtr activationContext, out nuint activationCookie, out string activationDiagnostic))
        {
            LastNativeDiagnostic = $"host={host}; manifestPresent={File.Exists(manifestPath)}; {activationDiagnostic}";
            return ShowCustomFallback(prompt, owner);
        }

        try
        {
            TaskDialogDisplayResult result = nativeOperations.ShowTaskDialog(prompt, owner);
            if (result.ExceptionName is not null)
            {
                LastNativeDiagnostic = result.ExceptionName is "EntryPointNotFoundException" or "DllNotFoundException"
                    ? "taskDialogException=" + result.ExceptionName : "taskDialog=unavailable";
            }
            else
            {
                LastNativeDiagnostic = $"host={host}; manifestPresent={File.Exists(manifestPath)}; {activationDiagnostic}; ownerValid={owner != IntPtr.Zero && nativeOperations.IsWindow(owner)}; configSize={Marshal.SizeOf<TaskDialogConfig>()}; taskDialogHResult=0x{result.HResult:X8}";
                if (result.HResult == 0)
                {
                    return MapSelectedButton(result.SelectedButton);
                }
            }
        }
        finally
        {
            nativeOperations.DeactivateActivationContext(activationCookie);
            nativeOperations.ReleaseActivationContext(activationContext);
        }

        return ShowCustomFallback(prompt, owner);
    }

    private ChromeConnectionConsentDecision ShowCustomFallback(ChromeConnectionConsentPrompt prompt, IntPtr owner)
    {
        ChromeConnectionConsentDecision decision = nativeOperations.ShowCustomDialog(prompt, owner, out string fallbackDiagnostic);
        LastNativeDiagnostic = $"{LastNativeDiagnostic}; {fallbackDiagnostic}";
        return decision;
    }

    private bool TryActivateCommonControls(string manifestPath, out IntPtr activationContext, out nuint activationCookie, out string diagnostic)
    {
        ActivationContextCreation creation = nativeOperations.CreateActivationContext(manifestPath);
        activationContext = creation.Handle;
        activationCookie = 0;
        if (!creation.Succeeded)
        {
            diagnostic = $"activationContext=CreateActCtxFailed:{creation.Error}";
            return false;
        }

        ActivationContextActivation activation = nativeOperations.ActivateActivationContext(activationContext);
        activationCookie = activation.Cookie;
        if (activation.Succeeded)
        {
            diagnostic = "activationContext=active";
            return true;
        }

        diagnostic = $"activationContext=ActivateActCtxFailed:{activation.Error}";
        nativeOperations.ReleaseActivationContext(activationContext);
        activationContext = IntPtr.Zero;
        return false;
    }

    ActivationContextCreation IChromeConsentNativeOperations.CreateActivationContext(string manifestPath)
    {
        var config = new ActivationContextConfig
        {
            cbSize = (uint)Marshal.SizeOf<ActivationContextConfig>(),
            lpSource = manifestPath,
        };
        IntPtr activationContext = CreateActCtx(ref config);
        return new(activationContext != InvalidActivationContext, activationContext, Marshal.GetLastWin32Error());
    }

    ActivationContextActivation IChromeConsentNativeOperations.ActivateActivationContext(IntPtr activationContext)
    {
        bool succeeded = ActivateActCtx(activationContext, out nuint activationCookie);
        return new(succeeded, activationCookie, Marshal.GetLastWin32Error());
    }

    void IChromeConsentNativeOperations.DeactivateActivationContext(nuint activationCookie) => DeactivateActCtx(0, activationCookie);

    void IChromeConsentNativeOperations.ReleaseActivationContext(IntPtr activationContext) => ReleaseActCtx(activationContext);

    IntPtr IChromeConsentNativeOperations.GetForegroundWindow() => GetForegroundWindow();

    bool IChromeConsentNativeOperations.IsWindow(IntPtr window) => IsWindow(window);

    TaskDialogDisplayResult IChromeConsentNativeOperations.ShowTaskDialog(ChromeConnectionConsentPrompt prompt, IntPtr owner)
    {
        var buttons = new[]
        {
            new TaskDialogButton(ConfirmButton, prompt.ConfirmLabel),
            new TaskDialogButton(CancelButton, ChromeConnectionConsentPrompt.CancelLabel),
        };
        int buttonSize = Marshal.SizeOf<TaskDialogButton>();
        IntPtr buttonsPointer = Marshal.AllocHGlobal(buttonSize * buttons.Length);
        TaskDialogCallback callback = (window, notification, wParam, lParam, data) =>
        {
            try
            {
                if (activePresentation is not null)
                {
                    activePresentation.WindowCreated |= IsWindow(window);
                    activePresentation.WindowVisible |= IsWindowVisible(window);
                }
            }
            catch { } // No managed exception may escape a native callback.
            return 0;
        };
        try
        {
            for (int index = 0; index < buttons.Length; index++)
            {
                Marshal.StructureToPtr(buttons[index], IntPtr.Add(buttonsPointer, index * buttonSize), false);
            }

            var config = new TaskDialogConfig
            {
                cbSize = (uint)Marshal.SizeOf<TaskDialogConfig>(),
                hwndParent = owner,
                dwFlags = AllowDialogCancellation | SetForeground |
                    (owner != IntPtr.Zero ? PositionRelativeToOwner : 0),
                pszWindowTitle = "CreatorCrate",
                pszMainInstruction = prompt.Instruction,
                pszContent = prompt.Content,
                cButtons = (uint)buttons.Length,
                pButtons = buttonsPointer,
                nDefaultButton = ConfirmButton,
                pfCallback = Marshal.GetFunctionPointerForDelegate(callback),
            };
            try
            {
                int result = TaskDialogIndirect(ref config, out int selectedButton, out _, out _);
                return new(result, selectedButton);
            }
            catch (Exception exception) when (exception is EntryPointNotFoundException or DllNotFoundException)
            {
                return new(-1, 0, exception.GetType().Name);
            }
        }
        finally
        {
            for (int index = 0; index < buttons.Length; index++)
            {
                Marshal.DestroyStructure<TaskDialogButton>(IntPtr.Add(buttonsPointer, index * buttonSize));
            }
            Marshal.FreeHGlobal(buttonsPointer);
            GC.KeepAlive(callback);
        }
    }

    ChromeConnectionConsentDecision IChromeConsentNativeOperations.ShowCustomDialog(
        ChromeConnectionConsentPrompt prompt,
        IntPtr owner,
        out string diagnostic) => NativeConsentWindow.Show(prompt, owner, out diagnostic, activePresentation);

    private delegate int TaskDialogCallback(IntPtr window, uint notification, IntPtr wParam, IntPtr lParam, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ActivationContextConfig
    {
        public uint cbSize;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpSource;
        public ushort wProcessorArchitecture;
        public ushort wLangId;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpAssemblyDirectory;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpResourceName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpApplicationName;
        public IntPtr hModule;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TaskDialogButton(int id, string text)
    {
        public int nButtonID = id;
        [MarshalAs(UnmanagedType.LPWStr)] public string pszButtonText = text;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct TaskDialogConfig
    {
        public uint cbSize;
        public IntPtr hwndParent;
        public IntPtr hInstance;
        public uint dwFlags;
        public uint dwCommonButtons;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszWindowTitle;
        public IntPtr hMainIcon;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszMainInstruction;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszContent;
        public uint cButtons;
        public IntPtr pButtons;
        public int nDefaultButton;
        public uint cRadioButtons;
        public IntPtr pRadioButtons;
        public int nDefaultRadioButton;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszVerificationText;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszExpandedInformation;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszExpandedControlText;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszCollapsedControlText;
        public IntPtr hFooterIcon;
        [MarshalAs(UnmanagedType.LPWStr)] public string? pszFooter;
        public IntPtr pfCallback;
        public IntPtr lpCallbackData;
        public uint cxWidth;
    }

    [DllImport("comctl32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int TaskDialogIndirect(ref TaskDialogConfig config, out int selectedButton, out int selectedRadioButton, out bool verificationChecked);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateActCtx(ref ActivationContextConfig config);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ActivateActCtx(IntPtr activationContext, out nuint activationCookie);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeactivateActCtx(uint flags, nuint activationCookie);

    [DllImport("kernel32.dll")]
    private static extern void ReleaseActCtx(IntPtr activationContext);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);
}

internal static class NativeConsentWindow
{
    private const int ConfirmButton = 100;
    private const int CancelButton = 101;
    private const uint WindowStyle = 0x80C80000; // WS_POPUP | WS_CAPTION | WS_SYSMENU
    private const uint ChildStyle = 0x50000000; // WS_CHILD | WS_VISIBLE
    private const uint ButtonStyle = ChildStyle | 0x00010000; // WS_TABSTOP
    private const uint DefaultButtonStyle = ButtonStyle | 0x00000001; // BS_DEFPUSHBUTTON
    private const uint StaticStyle = ChildStyle | 0x00000080; // SS_LEFT | SS_NOPREFIX
    private const int WmCommand = 0x0111;
    private const int WmClose = 0x0010;
    private const int WmKeyDown = 0x0100;
    private const int WmCtlColorStatic = 0x0138;
    private const int VkEscape = 0x1B;
    private const int SwShow = 5;
    private const int DefaultGuiFont = 17;
    private const int ColorBtnFace = 15;
    private const int ColorBtnText = 18;
    private const uint DrawTextCalcRect = 0x0400;
    private const uint DrawTextWordBreak = 0x0010;
    private const uint DrawTextNoPrefix = 0x0800;
    private const int ErrorClassAlreadyExists = 1410;
    private const string WindowClass = "CreatorCrateChromeConsentWindow";
    private static readonly object Sync = new();
    private static readonly Dictionary<IntPtr, DialogState> Dialogs = [];
    private static readonly WindowProcedure Procedure = WindowProc;
    private static ushort _classAtom;

    internal static NativeConsentDialogModel CreateModel(ChromeConnectionConsentPrompt prompt) => new(
        prompt.Instruction,
        prompt.Content,
        prompt.ConfirmLabel,
        ChromeConnectionConsentPrompt.CancelLabel);

    internal static ChromeConnectionConsentDecision Show(ChromeConnectionConsentPrompt prompt, IntPtr owner, out string diagnostic, NativePresentationResult? presentation = null)
    {
        if (!EnsureClass(out diagnostic))
        {
            return ChromeConnectionConsentDecision.DisplayFailed;
        }

        NativeConsentDialogModel model = CreateModel(prompt);
        IntPtr font = GetStockObject(DefaultGuiFont);
        const int clientWidth = 430;
        const int margin = 18;
        const int buttonWidth = 88;
        const int buttonHeight = 26;
        const int buttonGap = 8;
        int messageWidth = clientWidth - (margin * 2);
        int messageHeight = MeasureMessageHeight(model.Message, font, messageWidth);
        int buttonsY = margin + messageHeight + margin;
        int clientHeight = buttonsY + buttonHeight + margin;
        var windowRect = new Rectangle { Right = clientWidth, Bottom = clientHeight };
        AdjustWindowRectEx(ref windowRect, WindowStyle, false, 0x00000001); // WS_EX_DLGMODALFRAME
        int width = windowRect.Right - windowRect.Left;
        int height = windowRect.Bottom - windowRect.Top;
        GetDialogPosition(owner, width, height, out int x, out int y);
        IntPtr window = CreateWindowExW(
            0x00000001, // WS_EX_DLGMODALFRAME
            WindowClass,
            model.Title,
            WindowStyle,
            x,
            y,
            width,
            height,
            owner,
            IntPtr.Zero,
            GetModuleHandle(null),
            IntPtr.Zero);
        if (window == IntPtr.Zero)
        {
            diagnostic = $"customDialog=CreateWindowExFailed:{Marshal.GetLastWin32Error()}";
            return ChromeConnectionConsentDecision.DisplayFailed;
        }
        var state = new DialogState();
        if (presentation is not null) presentation.WindowCreated = true;
        lock (Sync)
        {
            Dialogs.Add(window, state);
        }

        try
        {
            IntPtr text = CreateWindowExW(0, "STATIC", model.Message, StaticStyle, margin, margin, messageWidth, messageHeight, window, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            int buttonsWidth = (buttonWidth * 2) + buttonGap;
            int firstButtonX = clientWidth - margin - buttonsWidth;
            IntPtr confirm = CreateWindowExW(0, "BUTTON", model.ConfirmLabel, DefaultButtonStyle, firstButtonX, buttonsY, buttonWidth, buttonHeight, window, (IntPtr)ConfirmButton, IntPtr.Zero, IntPtr.Zero);
            IntPtr cancel = CreateWindowExW(0, "BUTTON", model.CancelLabel, ButtonStyle, firstButtonX + buttonWidth + buttonGap, buttonsY, buttonWidth, buttonHeight, window, (IntPtr)CancelButton, IntPtr.Zero, IntPtr.Zero);
            if (text == IntPtr.Zero || confirm == IntPtr.Zero || cancel == IntPtr.Zero)
            {
                diagnostic = $"customDialog=CreateControlFailed:{Marshal.GetLastWin32Error()}";
                DestroyWindow(window);
                return ChromeConnectionConsentDecision.DisplayFailed;
            }

            SendMessage(text, 0x0030, font, IntPtr.Zero); // WM_SETFONT
            SendMessage(confirm, 0x0030, font, IntPtr.Zero);
            SendMessage(cancel, 0x0030, font, IntPtr.Zero);
            bool ownerWasEnabled = owner != IntPtr.Zero && IsWindow(owner) && IsWindowEnabled(owner);
            if (ownerWasEnabled)
            {
                EnableWindow(owner, false);
            }

            try
            {
                ShowWindow(window, SwShow);
                bool visible = IsWindowVisible(window);
                if (presentation is not null) presentation.WindowVisible = visible;
                if (!visible)
                {
                    diagnostic = "customDialog=not_visible";
                    return ChromeConnectionConsentDecision.DisplayFailed;
                }
                SetForegroundWindow(window);
                SetFocus(confirm);
                while (!state.Completed)
                {
                    int messageResult = GetMessage(out Message message, IntPtr.Zero, 0, 0);
                    if (messageResult <= 0)
                    {
                        diagnostic = $"customDialog=MessageLoopFailed:{Marshal.GetLastWin32Error()}";
                        return ChromeConnectionConsentDecision.DisplayFailed;
                    }

                    if (message.message == WmKeyDown && (int)message.wParam == VkEscape)
                    {
                        state.Decision = ChromeConnectionConsentDecision.Cancel;
                        state.Completed = true;
                        continue;
                    }

                    TranslateMessage(ref message);
                    DispatchMessage(ref message);
                }
            }
            finally
            {
                if (ownerWasEnabled)
                {
                    EnableWindow(owner, true);
                    SetForegroundWindow(owner);
                }
                if (IsWindow(window))
                {
                    DestroyWindow(window);
                }
            }

            diagnostic = "customDialog=shown";
            return state.Decision;
        }
        finally
        {
            if (IsWindow(window)) DestroyWindow(window);
            lock (Sync)
            {
                Dialogs.Remove(window);
            }
        }
    }

    private static bool EnsureClass(out string diagnostic)
    {
        lock (Sync)
        {
            if (_classAtom != 0)
            {
                diagnostic = "customDialogClass=registered";
                return true;
            }

            _classAtom = RegisterClassW(new WindowClassDefinition
            {
                lpfnWndProc = Procedure,
                hInstance = GetModuleHandle(null),
                hbrBackground = GetSysColorBrush(ColorBtnFace),
                lpszClassName = WindowClass,
            });
            int error = Marshal.GetLastWin32Error();
            if (_classAtom != 0 || error == ErrorClassAlreadyExists)
            {
                diagnostic = "customDialogClass=registered";
                return true;
            }

            diagnostic = $"customDialogClass=RegisterClassFailed:{error}";
            return false;
        }
    }

    private static IntPtr WindowProc(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        try { return WindowProcCore(window, message, wParam, lParam); }
        catch
        {
            lock (Sync)
            {
                if (Dialogs.TryGetValue(window, out var state))
                {
                    state.Decision = ChromeConnectionConsentDecision.DisplayFailed;
                    state.Completed = true;
                }
            }
            return IntPtr.Zero;
        }
    }

    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);

    private static IntPtr WindowProcCore(IntPtr window, uint message, IntPtr wParam, IntPtr lParam)
    {
        if (message == WmCtlColorStatic)
        {
            SetTextColor(wParam, GetSysColor(ColorBtnText));
            SetBkColor(wParam, GetSysColor(ColorBtnFace));
            return GetSysColorBrush(ColorBtnFace);
        }

        DialogState? state;
        lock (Sync)
        {
            Dialogs.TryGetValue(window, out state);
        }
        if (state is not null)
        {
            if (message == WmCommand)
            {
                int controlId = (int)((long)wParam & 0xffff);
                if (controlId is ConfirmButton or CancelButton)
                {
                    state.Decision = controlId == ConfirmButton
                        ? ChromeConnectionConsentDecision.Continue
                        : ChromeConnectionConsentDecision.Cancel;
                    state.Completed = true;
                    DestroyWindow(window);
                    return IntPtr.Zero;
                }
            }
            else if (message == WmClose || (message == WmKeyDown && (int)wParam == VkEscape))
            {
                state.Decision = ChromeConnectionConsentDecision.Cancel;
                state.Completed = true;
                DestroyWindow(window);
                return IntPtr.Zero;
            }
        }

        return DefWindowProcW(window, message, wParam, lParam);
    }

    private static int MeasureMessageHeight(string message, IntPtr font, int width)
    {
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero)
        {
            return 72;
        }

        IntPtr previousFont = SelectObject(screen, font);
        try
        {
            var rectangle = new Rectangle { Right = width };
            DrawTextW(screen, message, message.Length, ref rectangle, DrawTextCalcRect | DrawTextWordBreak | DrawTextNoPrefix);
            return Math.Max(1, rectangle.Bottom - rectangle.Top);
        }
        finally
        {
            if (previousFont != IntPtr.Zero)
            {
                SelectObject(screen, previousFont);
            }
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    private static void GetDialogPosition(IntPtr owner, int width, int height, out int x, out int y)
    {
        if (owner != IntPtr.Zero && IsWindow(owner) && GetWindowRect(owner, out Rectangle rectangle))
        {
            x = rectangle.Left + Math.Max(0, ((rectangle.Right - rectangle.Left) - width) / 2);
            y = rectangle.Top + Math.Max(0, ((rectangle.Bottom - rectangle.Top) - height) / 2);
            return;
        }

        x = (GetSystemMetrics(0) - width) / 2;
        y = (GetSystemMetrics(1) - height) / 2;
    }

    private sealed class DialogState
    {
        internal bool Completed { get; set; }
        internal ChromeConnectionConsentDecision Decision { get; set; } = ChromeConnectionConsentDecision.DisplayFailed;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr WindowProcedure(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClassDefinition
    {
        public uint style;
        public WindowProcedure? lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszMenuName;
        [MarshalAs(UnmanagedType.LPWStr)] public string? lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rectangle { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct Message
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public Point pt;
        public uint lPrivate;
    }

    [DllImport("user32.dll", EntryPoint = "CreateWindowExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(uint exStyle, string className, string windowName, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll", EntryPoint = "RegisterClassW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern ushort RegisterClassW([In] WindowClassDefinition windowClass);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr window);

    [DllImport("user32.dll", EntryPoint = "DefWindowProcW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Message message, IntPtr window, uint minimumFilter, uint maximumFilter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TranslateMessage([In] ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage([In] ref Message message);

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindowEnabled(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EnableWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool enable);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AdjustWindowRectEx(ref Rectangle rectangle, uint style, [MarshalAs(UnmanagedType.Bool)] bool menu, uint exStyle);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr window, IntPtr deviceContext);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int DrawTextW(IntPtr deviceContext, string text, int characterCount, ref Rectangle rectangle, uint format);

    [DllImport("user32.dll")]
    private static extern int GetSysColor(int index);

    [DllImport("user32.dll")]
    private static extern IntPtr GetSysColorBrush(int index);

    [DllImport("gdi32.dll")]
    private static extern IntPtr GetStockObject(int objectId);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr deviceContext, IntPtr graphicalObject);

    [DllImport("gdi32.dll")]
    private static extern uint SetBkColor(IntPtr deviceContext, int color);

    [DllImport("gdi32.dll")]
    private static extern uint SetTextColor(IntPtr deviceContext, int color);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? moduleName);
}

/// <summary>
/// Serializes operator-authorized Chrome connection attempts for one preparation run.
/// It never retries automatically and re-reads Chrome's current endpoint per retry.
/// </summary>
internal sealed class ManualReadyConsent(IChromeConnectionConsent local, string directory, string requestId,
    TimeSpan? responseTimeout = null) : IChromeConnectionConsent
{
    internal const string Gate = "CREATORCRATE_M2_MANUAL";
    internal const string DirectoryVariable = "CREATORCRATE_M2_READY_DIRECTORY";
    internal const string IdVariable = "CREATORCRATE_M2_READY_ID";
    private bool attempted;
    internal bool Requested { get; private set; }
    internal bool Accepted { get; private set; }
    internal NativePresentationResult? LocalPresentation => (local as NativeChromeConnectionConsent)?.LastPresentation;

    internal static IChromeConnectionConsent Create()
    {
        var local = new NativeChromeConnectionConsent();
        string? directory = Environment.GetEnvironmentVariable(DirectoryVariable);
        string? id = Environment.GetEnvironmentVariable(IdVariable);
        return Environment.GetEnvironmentVariable(Gate) == "1" && directory is not null && id is not null
            ? new ManualReadyConsent(local, directory, id) : local;
    }

    public ChromeConnectionConsentDecision ConfirmReady()
    {
        if (attempted) return ChromeConnectionConsentDecision.DisplayFailed;
        attempted = true;
        // ConfirmReady does not return until the host thread and all local resources are gone.
        var decision = local.ConfirmReady();
        if (decision != ChromeConnectionConsentDecision.DisplayFailed) return decision;
        try
        {
            if (!Guid.TryParseExact(requestId, "N", out _) || !Path.IsPathFullyQualified(directory)) return decision;
            string response = Path.Combine(directory, requestId + ".json");
            string consumed = Path.Combine(directory, "consumed", requestId + ".json");
            string request = Path.Combine(directory, "request.json");
            if (File.Exists(response) || File.Exists(consumed) || File.Exists(request)) return decision;
            Directory.CreateDirectory(Path.Combine(directory, "consumed"));
            var evidence = (local as NativeChromeConnectionConsent)?.LastPresentation;
            string payload = System.Text.Json.JsonSerializer.Serialize(new
            {
                RequestId = requestId, Type = "ready_consent",
                Presentation = evidence?.ToMarker() ?? "failed"
            });
            string temporary = Path.Combine(directory, "request.tmp");
            File.WriteAllText(temporary, payload);
            File.Move(temporary, request);
            Requested = true;
            try
            {
                var deadline = System.Diagnostics.Stopwatch.StartNew();
                while (deadline.Elapsed < (responseTimeout ?? TimeSpan.FromMinutes(5)))
                {
                    if (File.Exists(response))
                    {
                        File.Move(response, consumed); // No overwrite: the response is consumed before parsing.
                        if (new FileInfo(consumed).Length > 512) return decision;
                        using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(consumed));
                        var root = json.RootElement;
                        if (root.ValueKind != System.Text.Json.JsonValueKind.Object || root.EnumerateObject().Count() != 2 ||
                            root.GetProperty("RequestId").GetString() != requestId) return decision;
                        string? answer = root.GetProperty("Answer").GetString();
                        if (answer is not ("Continue" or "Cancel" or "DisplayFailed")) return decision;
                        Accepted = true;
                        return answer == "Continue" ? ChromeConnectionConsentDecision.Continue :
                            answer == "Cancel" ? ChromeConnectionConsentDecision.Cancel : decision;
                    }
                    Thread.Sleep(50);
                }
                return decision;
            }
            finally { File.Delete(request); }
        }
        catch { return ChromeConnectionConsentDecision.DisplayFailed; }
    }

    public ChromeConnectionConsentDecision ConfirmRetry(string errorCode) => local.ConfirmRetry(errorCode);
}

/// <summary>Manual harness only. No browser objects are created by either side of this exchange.</summary>
public static class ManualReadyConsentParent
{
    public static string? TryPresent(System.Diagnostics.Process child, string directory, string requestId)
        => TryPresent(child, directory, requestId, cancellation =>
        {
            var consent = new NativeChromeConnectionConsent(cancellation);
            var decision = consent.ConfirmReady();
            LastPresentation = consent.LastPresentation?.ToMarker() ?? "failed";
            return decision;
        });

    internal static string? TryPresent(System.Diagnostics.Process child, string directory, string requestId,
        Func<CancellationToken, ChromeConnectionConsentDecision> present)
    {
        string request = Path.Combine(directory, "request.json");
        if (child.HasExited || !File.Exists(request)) return null;
        string claim = Path.Combine(directory, "parent-consumed.json");
        if (File.Exists(claim)) return null;
        try
        {
            File.Move(request, claim);
            if (!Guid.TryParseExact(requestId, "N", out _) || new FileInfo(claim).Length > 1024) return "DisplayFailed";
            using var json = System.Text.Json.JsonDocument.Parse(File.ReadAllText(claim));
            var root = json.RootElement;
            if (root.EnumerateObject().Count() != 3 || root.GetProperty("RequestId").GetString() != requestId ||
                root.GetProperty("Type").GetString() != "ready_consent") return "DisplayFailed";
            string? evidence = root.GetProperty("Presentation").GetString();
            if (evidence != "failed" && !(evidence?.StartsWith("CREATORCRATE_MANUAL_PRESENTATION;state=failed;", StringComparison.Ordinal) ?? false)) return "DisplayFailed";
            using var cancellation = new CancellationTokenSource();
            using var monitor = new Timer(_ =>
            {
                try { if (child.HasExited) cancellation.Cancel(); }
                catch { cancellation.Cancel(); }
            }, null, 0, 50);
            var decision = present(cancellation.Token);
            return cancellation.IsCancellationRequested || child.HasExited ? null :
                decision is ChromeConnectionConsentDecision.Continue or ChromeConnectionConsentDecision.Cancel
                    ? decision.ToString() : "DisplayFailed";
        }
        catch { return "DisplayFailed"; }
    }

    public static string LastPresentation { get; private set; } = "not_invoked";
}

internal sealed class ChromeConnectionWorkflow
{
    private readonly Func<ChromeDiscoveryResult> _discover;
    private readonly ChromeConnection _connection;
    private readonly IChromeConnectionConsent _consent;
    private readonly ManualPreparationEvidence? _evidence;

    public ChromeConnectionWorkflow(ChromeDiscovery discovery, ChromeConnection connection, IChromeConnectionConsent consent,
        ManualPreparationEvidence? evidence = null)
        : this(discovery.Discover, connection, consent, evidence)
    {
    }

    internal ChromeConnectionWorkflow(Func<ChromeDiscoveryResult> discover, ChromeConnection connection, IChromeConnectionConsent consent,
        ManualPreparationEvidence? evidence = null)
    {
        _discover = discover ?? throw new ArgumentNullException(nameof(discover));
        _connection = connection ?? throw new ArgumentNullException(nameof(connection));
        _consent = consent ?? throw new ArgumentNullException(nameof(consent));
        _evidence = evidence;
    }

    public async Task<ChromeConnectionResult> ConnectAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_evidence is not null) _evidence.Consent = ManualBoundaryState.entered;
        ChromeConnectionConsentDecision? consumed = null;
        ChromeConnectionConsentDecision ready;
        try
        {
            ready = _consent.ConfirmReady();
            consumed = ready;
            if (_evidence is not null) _evidence.Consent = ManualBoundaryState.completed;
        }
        catch
        {
            if (_evidence is not null) _evidence.Consent = ManualBoundaryState.failed;
            throw;
        }
        finally { _evidence?.ObserveConsent(_consent, consumed); }
        if (ready == ChromeConnectionConsentDecision.DisplayFailed)
        {
            return ChromeConnectionResult.Fail("chrome_connection_prompt_failed");
        }
        if (ready != ChromeConnectionConsentDecision.Continue)
        {
            return ChromeConnectionResult.Fail("chrome_connection_ready_cancelled");
        }

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_evidence is not null) _evidence.Discovery = ManualBoundaryState.entered;
            ChromeDiscoveryResult discovered;
            try
            {
                discovered = _discover();
                _evidence?.ObserveDiscovery(discovered);
            }
            catch
            {
                if (_evidence is not null) _evidence.Discovery = ManualBoundaryState.failed;
                throw;
            }
            if (!discovered.Success)
            {
                return ChromeConnectionResult.Fail(discovered.ErrorCode!);
            }

            ChromeConnectionResult result = await _connection.ConnectAsync(discovered.Endpoint!, cancellationToken, _evidence).ConfigureAwait(false);
            if (result.Success || !IsRetryable(result.ErrorCode))
            {
                return result;
            }

            cancellationToken.ThrowIfCancellationRequested();
            ChromeConnectionConsentDecision retry = _consent.ConfirmRetry(result.ErrorCode!);
            if (retry == ChromeConnectionConsentDecision.DisplayFailed)
            {
                return ChromeConnectionResult.Fail("chrome_connection_prompt_failed");
            }
            if (retry != ChromeConnectionConsentDecision.Continue)
            {
                return ChromeConnectionResult.Fail("chrome_connection_retry_cancelled");
            }
        }
    }

    private static bool IsRetryable(string? errorCode) => errorCode is
        "chrome_connection_refused" or
        "chrome_approval_denied" or
        "chrome_handshake_failed" or
        "chrome_approval_timeout";
}
