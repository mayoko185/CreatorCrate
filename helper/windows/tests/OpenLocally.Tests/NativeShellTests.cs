using OpenLocally;

namespace OpenLocally.Tests;

/// <summary>
/// Focused coverage for the native Shell behavior of
/// <see cref="NativeShell"/>:
///
/// - folder-open (ShellExecuteExW "open" verb) is a direct call with no
///   apartment requirement and reports real success/failure;
/// - reveal/select (SHOpenFolderAndSelectItems) keeps the STA dispatch:
///   calls from a non-STA caller must be dispatched to an STA thread, calls
///   already on STA must execute inline, failures must be returned, and
///   exceptions from the STA path must not be swallowed.
///
/// The Shell invocations are replaced through the internal constructor, so
/// Explorer is never opened and no COM calls are made during tests.
/// </summary>
public class NativeShellTests
{
    private const int S_OK = 0;
    private const int HRESULT_FAILURE = unchecked((int)0x80004005);

    private static NativeShell CreateSelectionShell(Func<IntPtr, IntPtr[]?, int> shellOpen) =>
        new(_ => true, shellOpen);

    private static int RunOnWorkerThread(Func<bool> action)
    {
        int result = -1;
        var worker = new Thread(() => result = action() ? 1 : 0);
        worker.Start();
        worker.Join();
        return result;
    }

    // --- Folder-open: ShellExecuteExW "open" verb --------------------------

    [Fact]
    public void OpenFolder_CallsTheNativeSeamWithThePath()
    {
        string? received = null;
        var shell = new NativeShell(
            path => { received = path; return true; },
            (_, _) => S_OK);

        bool result = shell.OpenFolder(@"D:\example\000001-demo");

        Assert.True(result);
        Assert.Equal(@"D:\example\000001-demo", received);
    }

    [Fact]
    public void OpenFolder_ExecutesOnTheCallerThreadWithoutStaDispatch()
    {
        // Unlike the reveal/select API, the folder-open path is a plain
        // ShellExecuteExW call that works from any thread: it must never spin
        // up an STA thread. The seam must be invoked on the caller's own
        // thread, not on a dispatcher thread.
        int callerThreadId = -1;
        int invokedThreadId = -1;
        var shell = new NativeShell(
            _ => { invokedThreadId = Environment.CurrentManagedThreadId; return true; },
            (_, _) => S_OK);

        int result = -1;
        var worker = new Thread(() =>
        {
            callerThreadId = Environment.CurrentManagedThreadId;
            result = shell.OpenFolder(@"D:\example\000001-demo") ? 1 : 0;
        });
        worker.Start();
        worker.Join();

        Assert.Equal(1, result);
        Assert.Equal(callerThreadId, invokedThreadId);
    }

    [Fact]
    public void OpenFolder_SeamFailure_ReturnsFalse()
    {
        var shell = new NativeShell(_ => false, (_, _) => S_OK);

        bool result = shell.OpenFolder(@"D:\example\000001-demo");

        Assert.False(result);
    }

    [Fact]
    public void OpenFolder_SeamSuccess_ReturnsTrue()
    {
        var shell = new NativeShell(_ => true, (_, _) => S_OK);

        bool result = shell.OpenFolder(@"D:\example\000001-demo");

        Assert.True(result);
    }

    [Fact]
    public void OpenFolder_SeamException_PropagatesToCaller()
    {
        var expected = new InvalidOperationException("shell failed");
        var shell = new NativeShell(
            _ => throw expected,
            (_, _) => S_OK);

        int result = RunOnWorkerThread(() =>
        {
            try
            {
                shell.OpenFolder(@"D:\example\000001-demo");
            }
            catch (InvalidOperationException ex)
            {
                return ReferenceEquals(ex, expected);
            }
            return false;
        });

        Assert.Equal(1, result);
    }

    // --- Reveal/select: STA dispatch is preserved --------------------------

    [Fact]
    public void OpenFolderAndSelectItem_FromNonStaCaller_DispatchesToAnStaThread()
    {
        int callApartment = -1;
        NativeShell shell = CreateSelectionShell((_, _) =>
        {
            callApartment = (int)Thread.CurrentThread.GetApartmentState();
            return S_OK;
        });

        int result = RunOnWorkerThread(() => shell.OpenFolderAndSelectItem(new IntPtr(1), new IntPtr(2)));

        Assert.Equal(1, result);
        Assert.Equal((int)ApartmentState.STA, callApartment);
    }

    [Fact]
    public void OpenFolderAndSelectItem_FromStaCaller_ExecutesInlineWithoutMtaThread()
    {
        int callApartment = -1;
        NativeShell shell = CreateSelectionShell((_, _) =>
        {
            callApartment = (int)Thread.CurrentThread.GetApartmentState();
            return S_OK;
        });

        int result = -1;
        var staThread = new Thread(() => result = shell.OpenFolderAndSelectItem(new IntPtr(1), new IntPtr(2)) ? 1 : 0);
        staThread.SetApartmentState(ApartmentState.STA);
        staThread.Start();
        staThread.Join();

        Assert.Equal(1, result);
        Assert.Equal((int)ApartmentState.STA, callApartment);
    }

    [Fact]
    public void OpenFolderAndSelectItem_ShellFailure_ReturnsFalse()
    {
        NativeShell shell = CreateSelectionShell((_, _) => HRESULT_FAILURE);

        int result = RunOnWorkerThread(() => shell.OpenFolderAndSelectItem(new IntPtr(1), new IntPtr(2)));

        Assert.Equal(0, result);
    }

    [Fact]
    public void OpenFolderAndSelectItem_FromNonStaCaller_PropagatesExceptionFromShell()
    {
        var expected = new InvalidOperationException("shell failed");
        NativeShell shell = CreateSelectionShell((_, _) => throw expected);

        int result = RunOnWorkerThread(() =>
        {
            try
            {
                shell.OpenFolderAndSelectItem(new IntPtr(1), new IntPtr(2));
            }
            catch (InvalidOperationException ex)
            {
                return ReferenceEquals(ex, expected);
            }
            return false;
        });

        Assert.Equal(1, result);
    }
}
