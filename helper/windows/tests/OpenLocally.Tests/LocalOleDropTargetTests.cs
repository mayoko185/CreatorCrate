using OpenLocally.ManualVisualProof;

namespace OpenLocally.Tests;

public sealed class LocalOleDropTargetTests
{
    [Fact]
    public void Registration_RegistersOnceAndRevokesOnce()
    {
        var native = new RecordingRegistrationNative();
        var target = new LocalOleDropTarget();
        var registration = new LocalDropRegistration(new IntPtr(123), target, native);

        Assert.True(registration.Registered);
        Assert.Equal(new IntPtr(123), registration.RegisteredWindow);
        Assert.Equal(0, registration.RegistrationResult);
        Assert.Equal(new IntPtr(123), native.RegisteredWindow);
        Assert.Same(target, native.RegisteredTarget);

        registration.Dispose();
        registration.Dispose();

        Assert.False(registration.Registered);
        Assert.True(registration.Revoked);
        Assert.Equal(1, native.RegisterCalls);
        Assert.Equal(1, native.RevokeCalls);
        Assert.Equal(new IntPtr(123), native.RevokedWindow);
    }

    [Fact]
    public void Registration_FailureIsNotSilentlyIgnored()
    {
        var native = new RecordingRegistrationNative { RegisterResult = unchecked((int)0x8007000E) };

        Assert.Throws<OutOfMemoryException>(() =>
            new LocalDropRegistration(new IntPtr(123), new LocalOleDropTarget(), native));
        Assert.Equal(1, native.RegisterCalls);
        Assert.Equal(0, native.RevokeCalls);
    }

    [Fact]
    public void Registration_KeepsManagedDropTargetAliveUntilRevoke()
    {
        var native = new RecordingRegistrationNative { RetainRegisteredTarget = false };
        (LocalDropRegistration registration, WeakReference target) = CreateRegistration(native);

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();

        Assert.True(target.IsAlive);
        registration.Dispose();
        Assert.True(registration.Revoked);
    }

    [Fact]
    public void MissingCfHDrop_IsRejectedWithNoEffect()
    {
        var target = new LocalOleDropTarget();
        var data = new MissingFormatDataObject();
        uint effect = WindowsFileDrag.DropEffectCopy;

        Assert.Equal(0, target.DragEnter(data, 0, default, ref effect));
        Assert.Equal(0u, effect);
        effect = WindowsFileDrag.DropEffectCopy;
        Assert.Equal(0, target.Drop(data, 0, default, ref effect));

        Assert.Equal(0u, effect);
        LocalDropResult result = Assert.IsType<LocalDropResult>(target.LastResult);
        Assert.False(result.DropReceived);
        Assert.Contains("CF_HDROP", result.Error, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(2u)]
    [InlineData(4u)]
    public void NonCopyEffects_AreRejectedWithoutDecoding(uint offeredEffect)
    {
        var target = new LocalOleDropTarget();
        var data = new FileDropDataObject([Path.GetFullPath(@"C:\CreatorCrate proof\one.png")]);
        uint effect = offeredEffect;

        Assert.Equal(0, target.DragEnter(data, 0, default, ref effect));
        Assert.Equal(0u, effect);
        effect = offeredEffect;
        Assert.Equal(0, target.Drop(data, 0, default, ref effect));

        Assert.Equal(0u, effect);
        Assert.False(Assert.IsType<LocalDropResult>(target.LastResult).DropReceived);
    }

    [Fact]
    public void OneFile_DecodesActualHGlobalAndReleasesStorage()
    {
        string path = Path.GetFullPath(@"C:\CreatorCrate proof\one.png");
        var release = new RecordingMediumReleaser();
        LocalDropResult result = Drop([path], release);

        Assert.True(result.DropReceived);
        Assert.Equal(1, result.Count);
        Assert.Equal([path], result.Paths);
        Assert.Equal(WindowsFileDrag.DropEffectCopy, result.Effect);
        Assert.Equal(1, release.ReleaseCalls);
        Assert.NotEqual(IntPtr.Zero, release.ReleasedHandle);
    }

    [Fact]
    public void ThreeFiles_PreservesIncomingOrderWithoutSorting()
    {
        string[] paths =
        [
            Path.GetFullPath(@"C:\CreatorCrate proof\z-first.png"),
            Path.GetFullPath(@"C:\CreatorCrate proof\a-middle.png"),
            Path.GetFullPath(@"C:\CreatorCrate proof\m-last.txt"),
        ];

        LocalDropResult result = Drop(paths, new RecordingMediumReleaser());

        Assert.True(result.DropReceived);
        Assert.Equal(3, result.Count);
        Assert.Equal(paths, result.Paths);
    }

    [Fact]
    public void UnicodePaths_RoundTripThroughReceivedCfHDrop()
    {
        string[] paths =
        [
            Path.GetFullPath(@"C:\CreatorCrate proof\café 日本語\👩🏽‍💻-launch.png"),
            Path.GetFullPath(@"C:\CreatorCrate proof\résumé-✅.txt"),
        ];

        LocalDropResult result = Drop(paths, new RecordingMediumReleaser());

        Assert.Equal(paths, result.Paths);
    }

    [Fact]
    public void DropResult_DoesNotRetainCallerOwnedHGlobal()
    {
        var release = new RecordingMediumReleaser();
        LocalDropResult result = Drop([Path.GetFullPath(@"C:\CreatorCrate proof\one.png")], release);

        Assert.Equal(1, release.ReleaseCalls);
        Assert.NotEqual(IntPtr.Zero, release.ReleasedHandle);
        Assert.All(result.Paths, path => Assert.IsType<string>(path));
        Assert.DoesNotContain(
            result.GetType().GetProperties(),
            property => property.PropertyType == typeof(IntPtr));
    }

    [Fact]
    public void Drop_DoesNotCreateOrModifyFiles()
    {
        string root = Path.Combine(Path.GetTempPath(), $"creatorcrate-drop-target-{Guid.NewGuid():N}");
        string path = Path.Combine(root, "not-created.png");

        LocalDropResult result = Drop([path], new RecordingMediumReleaser());

        Assert.True(result.DropReceived);
        Assert.False(Directory.Exists(root));
        Assert.False(File.Exists(path));
    }

    private static (LocalDropRegistration Registration, WeakReference Target) CreateRegistration(
        RecordingRegistrationNative native)
    {
        var target = new LocalOleDropTarget();
        return (new LocalDropRegistration(new IntPtr(123), target, native), new WeakReference(target));
    }

    private static LocalDropResult Drop(IReadOnlyList<string> paths, RecordingMediumReleaser release)
    {
        var data = new FileDropDataObject(paths);
        var target = new LocalOleDropTarget(new LocalFileDropDecoder(release));
        uint effect = WindowsFileDrag.DropEffectCopy;
        Assert.Equal(0, target.DragEnter(data, 0, default, ref effect));
        Assert.Equal(WindowsFileDrag.DropEffectCopy, effect);
        Assert.Equal(0, target.Drop(data, 0, default, ref effect));
        Assert.Equal(WindowsFileDrag.DropEffectCopy, effect);
        return Assert.IsType<LocalDropResult>(target.LastResult);
    }

    private sealed class RecordingRegistrationNative : ILocalDropRegistrationNative
    {
        internal int RegisterResult { get; init; }
        internal bool RetainRegisteredTarget { get; init; } = true;
        internal int RegisterCalls { get; private set; }
        internal int RevokeCalls { get; private set; }
        internal IntPtr RegisteredWindow { get; private set; }
        internal ILocalOleDropTarget? RegisteredTarget { get; private set; }
        internal IntPtr RevokedWindow { get; private set; }

        public int Register(IntPtr window, ILocalOleDropTarget target)
        {
            RegisterCalls++;
            RegisteredWindow = window;
            if (RetainRegisteredTarget) RegisteredTarget = target;
            return RegisterResult;
        }

        public int Revoke(IntPtr window)
        {
            RevokeCalls++;
            RevokedWindow = window;
            return 0;
        }
    }

    private sealed class RecordingMediumReleaser : IStorageMediumReleaser
    {
        internal int ReleaseCalls { get; private set; }
        internal IntPtr ReleasedHandle { get; private set; }

        public void Release(ref StgMedium medium)
        {
            ReleaseCalls++;
            ReleasedHandle = medium.unionMember;
            NativeStorageMediumReleaser.Instance.Release(ref medium);
            medium = default;
        }
    }

    private sealed class MissingFormatDataObject : IFileDropDataObject
    {
        public int GetData(ref FormatEtc format, out StgMedium medium)
        {
            medium = default;
            return FileDropDataObject.DV_E_FORMATETC;
        }

        public int GetDataHere(ref FormatEtc format, ref StgMedium medium) => FileDropDataObject.E_NOTIMPL;
        public int QueryGetData(ref FormatEtc format) => FileDropDataObject.DV_E_FORMATETC;
        public int GetCanonicalFormatEtc(ref FormatEtc input, out FormatEtc output)
        {
            output = default;
            return FileDropDataObject.E_NOTIMPL;
        }
        public int SetData(ref FormatEtc format, ref StgMedium medium, bool release) => FileDropDataObject.E_NOTIMPL;
        public int EnumFormatEtc(uint direction, out IntPtr enumerator)
        {
            enumerator = IntPtr.Zero;
            return FileDropDataObject.E_NOTIMPL;
        }
        public int DAdvise(ref FormatEtc format, uint flags, IntPtr sink, out uint connection)
        {
            connection = 0;
            return FileDropDataObject.E_NOTIMPL;
        }
        public int DUnadvise(uint connection) => FileDropDataObject.E_NOTIMPL;
        public int EnumDAdvise(out IntPtr enumerator)
        {
            enumerator = IntPtr.Zero;
            return FileDropDataObject.E_NOTIMPL;
        }
    }
}
