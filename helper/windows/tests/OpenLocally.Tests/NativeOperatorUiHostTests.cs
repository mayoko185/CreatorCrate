using OpenLocally;

namespace OpenLocally.Tests;

internal sealed class AttachedTestDesktop : NativeOperatorUiHost.Native
{
    public override bool Execute(NativePresentationStage stage, NativePresentationResult result) => true;
}

public class NativeOperatorUiHostTests
{
    [Fact]
    public void SetThreadDesktopSuccessContinuesAndReleasesOnlyOwnedDesktop()
    {
        var native = new Desktop { SetSucceeds = true };
        int calls = 0;

        var result = NativeOperatorUiHost.Show(native, _ => calls++);

        Assert.Equal(1, calls);
        Assert.True(result.InputDesktopOpened);
        Assert.True(result.ThreadDesktopSelected);
        Assert.Equal(0, native.CurrentDesktopCalls);
        Assert.Equal([Desktop.InputHandle], native.ClosedHandles);
        Assert.DoesNotContain(Desktop.CurrentHandle, native.ClosedHandles);
    }

    [Fact]
    public void NonBusySetThreadDesktopFailureRemainsFatal()
    {
        var native = new Desktop { SetSucceeds = false, SetError = 5 };

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 5);
        Assert.Equal(0, native.CurrentDesktopCalls);
        Assert.Equal([Desktop.InputHandle], native.ClosedHandles);
    }

    [Fact]
    public void BusyWithNullCurrentDesktopRemainsFatal()
    {
        var native = BusyDesktop();
        native.CurrentDesktop = IntPtr.Zero;

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
        Assert.Empty(native.IdentityRequests);
    }

    [Fact]
    public void BusyWithMatchingDesktopIdentitiesIsAccepted()
    {
        var native = BusyDesktop();
        int calls = 0;

        var result = NativeOperatorUiHost.Show(native, _ => calls++);

        Assert.Equal(1, calls);
        Assert.True(result.ThreadDesktopSelected);
        Assert.Equal([Desktop.InputHandle, Desktop.CurrentHandle], native.IdentityRequests);
        Assert.Equal([Desktop.InputHandle], native.ClosedHandles);
        Assert.DoesNotContain(Desktop.CurrentHandle, native.ClosedHandles);
    }

    [Fact]
    public void BusyWithDifferentDesktopIdentitiesRemainsFatal()
    {
        var native = BusyDesktop();
        native.CurrentIdentity = "Other";

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
    }

    [Fact]
    public void BusyWithInputIdentityLookupFailureRemainsFatal()
    {
        var native = BusyDesktop();
        native.InputIdentitySucceeds = false;

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
        Assert.Equal([Desktop.InputHandle, Desktop.CurrentHandle], native.IdentityRequests);
    }

    [Fact]
    public void BusyWithCurrentIdentityLookupFailureRemainsFatal()
    {
        var native = BusyDesktop();
        native.CurrentIdentitySucceeds = false;

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
        Assert.Equal([Desktop.InputHandle, Desktop.CurrentHandle], native.IdentityRequests);
    }

    [Fact]
    public void BusyAttemptsBothIdentityLookupsWhenBothFail()
    {
        var native = BusyDesktop();
        native.InputIdentitySucceeds = false;
        native.CurrentIdentitySucceeds = false;

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
        Assert.Equal([Desktop.InputHandle, Desktop.CurrentHandle], native.IdentityRequests);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void BusyWithEmptyIdentityRemainsFatal(bool emptyInputIdentity)
    {
        var native = BusyDesktop();
        if (emptyInputIdentity) native.InputIdentity = string.Empty;
        else native.CurrentIdentity = string.Empty;

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.set_thread_desktop, 170);
    }

    [Fact]
    public void OpenInputDesktopFailureNeverEntersDialog()
    {
        var native = new Desktop { OpenSucceeds = false, OpenError = 5 };

        var result = NativeOperatorUiHost.Show(native, _ => Assert.Fail("Dialog must not run."));

        AssertAttachmentFailure(result, NativePresentationStage.open_input_desktop, 5);
        Assert.Empty(native.ClosedHandles);
    }

    [Fact]
    public void BodyIsOnDedicatedStaAfterBothDesktopOperationsAndDisposesBeforeOwnedHandleRelease()
    {
        var native = new Desktop();
        int caller = Environment.CurrentManagedThreadId;
        int body = 0;

        var result = NativeOperatorUiHost.Show(native, presentation =>
        {
            body = Environment.CurrentManagedThreadId;
            Assert.NotEqual(caller, body);
            Assert.Equal(ApartmentState.STA, Thread.CurrentThread.GetApartmentState());
            Assert.True(presentation.InputDesktopOpened && presentation.ThreadDesktopSelected);
        });

        Assert.NotEqual(NativePresentationStage.unexpected, result.Stage);
        Assert.Equal(body, native.DisposeThread);
        Assert.Equal(caller, native.CloseThread);
        Assert.Equal(["open", "set", "dispose", "close"], native.LifetimeOperations);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CallbackAndNativeFailuresContainPrivateDetails(bool nativeThrows)
    {
        var native = new Desktop { Throw = nativeThrows };
        var result = NativeOperatorUiHost.Show(native, _ => throw new Exception("PRIVATE CodexSandboxDesktop-secret"));
        Assert.Equal(NativePresentationStage.unexpected, result.Stage);
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.DoesNotContain("PRIVATE", result.ToMarker());
        Assert.DoesNotContain("Desktop-secret", result.ToMarker());
        Assert.True(native.Disposed);
    }

    private static Desktop BusyDesktop()
    {
        return new Desktop { SetSucceeds = false, SetError = 170 };
    }

    private static void AssertAttachmentFailure(NativePresentationResult result, NativePresentationStage stage, int code)
    {
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.Equal(stage, result.Stage);
        Assert.Equal(code, result.Win32Code);
        Assert.False(result.ThreadDesktopSelected);
    }

    private sealed class Desktop : NativeOperatorUiHost.Native
    {
        internal static readonly IntPtr InputHandle = new(101);
        internal static readonly IntPtr CurrentHandle = new(202);

        public bool OpenSucceeds { get; set; } = true;
        public int OpenError { get; set; }
        public bool SetSucceeds { get; set; } = true;
        public int SetError { get; set; }
        public IntPtr CurrentDesktop { get; set; } = CurrentHandle;
        public bool InputIdentitySucceeds { get; set; } = true;
        public bool CurrentIdentitySucceeds { get; set; } = true;
        public string InputIdentity { get; set; } = "Default";
        public string CurrentIdentity { get; set; } = "Default";
        public bool Throw { get; init; }
        public bool Disposed { get; private set; }
        public int DisposeThread { get; private set; }
        public int CloseThread { get; private set; }
        public int CurrentDesktopCalls { get; private set; }
        public List<IntPtr> IdentityRequests { get; } = [];
        public List<IntPtr> ClosedHandles { get; } = [];
        public List<string> LifetimeOperations { get; } = [];

        internal override IntPtr OpenInputDesktopHandle()
        {
            Assert.Equal(ApartmentState.STA, Thread.CurrentThread.GetApartmentState());
            LifetimeOperations.Add("open");
            if (Throw) throw new Exception("PRIVATE CodexSandboxDesktop-secret");
            return OpenSucceeds ? InputHandle : IntPtr.Zero;
        }

        internal override bool SetThreadDesktopHandle(IntPtr desktopHandle)
        {
            Assert.Equal(InputHandle, desktopHandle);
            LifetimeOperations.Add("set");
            return SetSucceeds;
        }

        internal override int CaptureLastError()
        {
            return LifetimeOperations.Last() == "open" ? OpenError : SetError;
        }

        internal override IntPtr GetCurrentThreadDesktopHandle()
        {
            CurrentDesktopCalls++;
            return CurrentDesktop;
        }

        internal override bool TryGetDesktopName(IntPtr desktopHandle, out string name)
        {
            IdentityRequests.Add(desktopHandle);
            if (desktopHandle == InputHandle)
            {
                name = InputIdentity;
                return InputIdentitySucceeds;
            }
            Assert.Equal(CurrentHandle, desktopHandle);
            name = CurrentIdentity;
            return CurrentIdentitySucceeds;
        }

        internal override bool CloseDesktopHandle(IntPtr desktopHandle)
        {
            LifetimeOperations.Add("close");
            CloseThread = Environment.CurrentManagedThreadId;
            ClosedHandles.Add(desktopHandle);
            return true;
        }

        public override void Dispose()
        {
            LifetimeOperations.Add("dispose");
            Disposed = true;
            DisposeThread = Environment.CurrentManagedThreadId;
        }
    }
}
