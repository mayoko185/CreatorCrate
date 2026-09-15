using OpenLocally;

namespace OpenLocally.Tests;

public class NativeUnicodeClipboardTests
{
    [Fact]
    public void Success_UnlocksBeforeTransferAndNeverFreesTransferredMemory()
    {
        var native = new RecordingNative();

        Assert.True(new NativeUnicodeClipboard(new IntPtr(7), native).TrySetText("Unicode 雪 🚀"));

        Assert.Equal(new[] { "open", "empty", "allocate", "lock", "copy", "unlock", "set", "close" }, native.Calls);
        Assert.Equal("Unicode 雪 🚀\0", System.Text.Encoding.Unicode.GetString(native.CopiedBytes!));
        Assert.Equal(0, native.FreeCalls);
    }

    [Fact]
    public void GlobalLockFailure_FreesOwnedUnlockedAllocation()
    {
        var native = new RecordingNative { LockResult = IntPtr.Zero };

        Assert.False(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(1, native.FreeCalls);
        Assert.DoesNotContain("unlock", native.Calls);
    }

    [Fact]
    public void CopyException_UnlocksBeforeFreeingOwnedAllocation()
    {
        var native = new RecordingNative { ThrowOnCopy = true };

        Assert.False(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.True(native.Calls.IndexOf("unlock") < native.Calls.IndexOf("free"));
        Assert.Equal(1, native.FreeCalls);
    }

    [Fact]
    public void GlobalUnlockNonzero_IsSuccessWithoutReadingLastError()
    {
        var native = new RecordingNative { UnlockResult = true, LastError = 5 };

        Assert.True(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(0, native.GetLastErrorCalls);
        Assert.Equal(0, native.FreeCalls);
    }

    [Fact]
    public void GlobalUnlockZeroWithNoError_IsSuccessfulFullUnlock()
    {
        var native = new RecordingNative { UnlockResult = false, LastError = 0 };

        Assert.True(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(1, native.GetLastErrorCalls);
        Assert.Equal(new[] { "unlock", "last-error", "set" }, native.Calls.GetRange(5, 3));
    }

    [Fact]
    public void GlobalUnlockZeroWithError_FailsWithoutFreeingStillLockedMemory()
    {
        var native = new RecordingNative { UnlockResult = false, LastError = 5 };

        Assert.False(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(1, native.UnlockCalls);
        Assert.Equal(0, native.FreeCalls);
        Assert.DoesNotContain("set", native.Calls);
    }

    [Fact]
    public void SetClipboardDataFailure_KeepsOwnershipAndFreesUnlockedAllocation()
    {
        var native = new RecordingNative { SetResult = IntPtr.Zero };

        Assert.False(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(1, native.FreeCalls);
        Assert.True(native.Calls.IndexOf("set") < native.Calls.IndexOf("free"));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public void ClipboardOpenAndEmptyFailures_CloseOnlyAnActuallyOpenedClipboard(bool openSucceeds, bool emptyFails)
    {
        var native = new RecordingNative { OpenResult = openSucceeds, EmptyResult = !emptyFails };

        Assert.False(new NativeUnicodeClipboard(IntPtr.Zero, native).TrySetText("text"));

        Assert.Equal(openSucceeds ? 1 : 0, native.CloseCalls);
        Assert.Equal(0, native.FreeCalls);
    }

    [Fact]
    public void FailedOperation_CanBeRetriedWithTheSameExactText()
    {
        var native = new RecordingNative { SetFailuresRemaining = 1 };
        var clipboard = new NativeUnicodeClipboard(IntPtr.Zero, native);

        Assert.False(clipboard.TrySetText("same\r\n雪 🚀"));
        Assert.True(clipboard.TrySetText("same\r\n雪 🚀"));

        Assert.Equal(1, native.FreeCalls);
        Assert.Equal(2, native.CopyCalls);
        Assert.All(native.CopiedPayloads, bytes => Assert.Equal("same\r\n雪 🚀\0", System.Text.Encoding.Unicode.GetString(bytes)));
    }

    private sealed class RecordingNative : NativeUnicodeClipboard.ClipboardNative
    {
        public List<string> Calls { get; } = [];
        public List<byte[]> CopiedPayloads { get; } = [];
        public byte[]? CopiedBytes => CopiedPayloads.LastOrDefault();
        public bool OpenResult { get; init; } = true;
        public bool EmptyResult { get; init; } = true;
        public IntPtr LockResult { get; init; } = new(200);
        public bool ThrowOnCopy { get; init; }
        public bool UnlockResult { get; init; } = true;
        public int LastError { get; init; }
        public IntPtr SetResult { get; init; } = new(300);
        public int SetFailuresRemaining { get; set; }
        public int UnlockCalls { get; private set; }
        public int GetLastErrorCalls { get; private set; }
        public int FreeCalls { get; private set; }
        public int CloseCalls { get; private set; }
        public int CopyCalls { get; private set; }

        internal override bool OpenClipboard(IntPtr owner) { Calls.Add("open"); return OpenResult; }
        internal override bool EmptyClipboard() { Calls.Add("empty"); return EmptyResult; }
        internal override IntPtr GlobalAlloc(uint flags, UIntPtr bytes) { Calls.Add("allocate"); return new IntPtr(100); }
        internal override IntPtr GlobalLock(IntPtr memory) { Calls.Add("lock"); return LockResult; }
        internal override void Copy(byte[] bytes, IntPtr target)
        {
            Calls.Add("copy");
            CopyCalls++;
            if (ThrowOnCopy) throw new InvalidOperationException("copy failed");
            CopiedPayloads.Add(bytes.ToArray());
        }
        internal override bool GlobalUnlock(IntPtr memory) { Calls.Add("unlock"); UnlockCalls++; return UnlockResult; }
        internal override int GetLastError() { Calls.Add("last-error"); GetLastErrorCalls++; return LastError; }
        internal override IntPtr SetClipboardData(uint format, IntPtr memory)
        {
            Calls.Add("set");
            if (SetFailuresRemaining-- > 0) return IntPtr.Zero;
            return SetResult;
        }
        internal override IntPtr GlobalFree(IntPtr memory) { Calls.Add("free"); FreeCalls++; return IntPtr.Zero; }
        internal override bool CloseClipboard() { Calls.Add("close"); CloseCalls++; return true; }
    }
}
