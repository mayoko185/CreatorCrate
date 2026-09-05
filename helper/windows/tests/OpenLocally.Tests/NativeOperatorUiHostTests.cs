using OpenLocally;

namespace OpenLocally.Tests;

internal sealed class AttachedTestDesktop : NativeOperatorUiHost.Native
{
    public override bool Execute(NativePresentationStage stage, NativePresentationResult result) => true;
}

public class NativeOperatorUiHostTests
{
    [Theory]
    [InlineData(NativePresentationStage.open_input_desktop, 5)]
    [InlineData(NativePresentationStage.set_thread_desktop, 5)]
    [InlineData(NativePresentationStage.set_thread_desktop, 170)]
    public void AttachmentFailureNeverEntersDialog(NativePresentationStage stage, int code)
    {
        var native = new Desktop(stage, code);
        int calls = 0;
        var result = NativeOperatorUiHost.Show(native, _ => calls++);
        Assert.Equal(0, calls);
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.Equal(stage, result.Stage);
        Assert.Equal(code, result.Win32Code);
        Assert.False(result.ThreadDesktopSelected);
        Assert.True(native.Disposed);
    }

    [Fact]
    public void BodyIsOnDedicatedStaAfterBothDesktopOperationsAndDisposesOnThatThread()
    {
        var native = new Desktop(null, 0);
        int caller = Environment.CurrentManagedThreadId;
        int body = 0;
        var result = NativeOperatorUiHost.Show(native, result =>
        {
            body = Environment.CurrentManagedThreadId;
            Assert.NotEqual(caller, body);
            Assert.Equal(ApartmentState.STA, Thread.CurrentThread.GetApartmentState());
            Assert.Equal([NativePresentationStage.open_input_desktop, NativePresentationStage.set_thread_desktop], native.Stages);
            Assert.True(result.InputDesktopOpened && result.ThreadDesktopSelected);
        });
        Assert.NotEqual(NativePresentationStage.unexpected, result.Stage);
        Assert.Equal(body, native.DisposeThread);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void CallbackAndNativeFailuresContainPrivateDetails(bool nativeThrows)
    {
        var native = new Desktop(null, 0) { Throw = nativeThrows };
        var result = NativeOperatorUiHost.Show(native, _ => throw new Exception("PRIVATE CodexSandboxDesktop-secret"));
        Assert.Equal(NativePresentationStage.unexpected, result.Stage);
        Assert.Equal(NativePresentationState.Failed, result.State);
        Assert.DoesNotContain("PRIVATE", result.ToMarker());
        Assert.DoesNotContain("Desktop-secret", result.ToMarker());
        Assert.True(native.Disposed);
    }

    private sealed class Desktop(NativePresentationStage? failure, int code) : NativeOperatorUiHost.Native
    {
        public List<NativePresentationStage> Stages { get; } = [];
        public bool Throw { get; init; }
        public bool Disposed { get; private set; }
        public int DisposeThread { get; private set; }
        public override int LastError => code;
        public override bool Execute(NativePresentationStage stage, NativePresentationResult result)
        {
            Assert.Equal(ApartmentState.STA, Thread.CurrentThread.GetApartmentState());
            Stages.Add(stage);
            if (Throw) throw new Exception("PRIVATE CodexSandboxDesktop-secret");
            return stage != failure;
        }
        public override void Dispose() { Disposed = true; DisposeThread = Environment.CurrentManagedThreadId; }
    }
}
