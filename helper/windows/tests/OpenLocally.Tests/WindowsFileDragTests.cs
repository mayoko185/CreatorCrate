using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using OpenLocally;

namespace OpenLocally.Tests;

public class WindowsFileDragTests
{
    [Theory]
    [MemberData(nameof(PayloadCases))]
    public void DropFilesPayload_IsUnicodeOrderedAndDoubleNullTerminated(string[] paths)
    {
        byte[] payload = FileDropHGlobal.BuildPayload(paths);

        Assert.Equal(FileDropHGlobal.DropFilesSize, BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(0, 4)));
        Assert.Equal(1, BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(16, 4)));
        Assert.Equal(string.Join('\0', paths) + "\0\0", Encoding.Unicode.GetString(payload, FileDropHGlobal.DropFilesSize,
            payload.Length - FileDropHGlobal.DropFilesSize));
    }

    public static IEnumerable<object[]> PayloadCases()
    {
        yield return [new[] { @"C:\stage\one.png" }];
        yield return [new[] { @"C:\stage with spaces\one file.png", @"D:\雪\кот.png" }];
        yield return [new[] { @"D:\third.png", @"C:\first.png", @"C:\second.png" }];
    }

    [Fact]
    public void DropFilesPayload_RejectsRelativePathsAndOverflow()
    {
        Assert.Throws<ArgumentException>(() => FileDropHGlobal.BuildPayload(["relative.png"]));
        Assert.Throws<OverflowException>(() => FileDropHGlobal.CalculatePayloadSize([int.MaxValue]));
    }

    [Fact]
    public void QueryGetData_ValidatesEveryRequiredFieldAndAcceptsTymedMask()
    {
        var data = new FileDropDataObject([@"C:\stage\one.png"]);
        FormatEtc format = ValidFormat();

        format.tymed |= 4;
        Assert.Equal(FileDropDataObject.S_OK, data.QueryGetData(ref format));
        format = ValidFormat(); format.cfFormat = 13;
        Assert.Equal(FileDropDataObject.DV_E_FORMATETC, data.QueryGetData(ref format));
        format = ValidFormat(); format.dwAspect = 2;
        Assert.Equal(FileDropDataObject.DV_E_DVASPECT, data.QueryGetData(ref format));
        format = ValidFormat(); format.lindex = 0;
        Assert.Equal(FileDropDataObject.DV_E_LINDEX, data.QueryGetData(ref format));
        format = ValidFormat(); format.tymed = 4;
        Assert.Equal(FileDropDataObject.DV_E_TYMED, data.QueryGetData(ref format));
    }

    [Fact]
    public void RepeatedGetData_ReturnsDistinctCallerOwnedCompleteStorage()
    {
        string[] paths = [@"C:\stage\one file.png", @"D:\雪\two.png"];
        var data = new FileDropDataObject(paths);
        FormatEtc format = ValidFormat();

        Assert.Equal(0, data.GetData(ref format, out StgMedium first));
        Assert.Equal(0, data.GetData(ref format, out StgMedium second));
        try
        {
            Assert.NotEqual(IntPtr.Zero, first.unionMember);
            Assert.NotEqual(first.unionMember, second.unionMember);
            Assert.Equal(FileDropDataObject.TymedHGlobal, first.tymed);
            Assert.Equal(IntPtr.Zero, first.pUnkForRelease);
            Assert.Equal(FileDropHGlobal.BuildPayload(paths), ReadGlobal(first.unionMember));
            Assert.Equal(FileDropHGlobal.BuildPayload(paths), ReadGlobal(second.unionMember));
        }
        finally
        {
            ReleaseStgMedium(ref first);
            ReleaseStgMedium(ref second);
        }
    }

    [Fact]
    public void EnumFormatEtc_DiscoverySequenceAdvertisesAndProvidesOnlyFileDrop()
    {
        var data = new FileDropDataObject([@"C:\stage\one.png"]);

        Assert.Equal(FileDropDataObject.S_OK,
            data.EnumFormatEtc(FileDropDataObject.DatadirGet, out IntPtr pointer));
        Assert.NotEqual(IntPtr.Zero, pointer);

        object value = Marshal.GetObjectForIUnknown(pointer);
        try
        {
            var formats = Assert.IsAssignableFrom<IEnumFORMATETC>(value);
            FORMATETC[] discovered = new FORMATETC[1];
            int[] fetched = new int[1];

            Assert.Equal(FileDropFormatEnumerator.S_OK, formats.Next(1, discovered, fetched));
            Assert.Equal(1, fetched[0]);
            Assert.Equal(FileDropHGlobal.CfHDrop, discovered[0].cfFormat);
            Assert.Equal(IntPtr.Zero, discovered[0].ptd);
            Assert.Equal(DVASPECT.DVASPECT_CONTENT, discovered[0].dwAspect);
            Assert.Equal(-1, discovered[0].lindex);
            Assert.Equal(TYMED.TYMED_HGLOBAL, discovered[0].tymed);

            FormatEtc requested = FromComFormat(discovered[0]);
            Assert.Equal(FileDropDataObject.S_OK, data.QueryGetData(ref requested));
            Assert.Equal(FileDropDataObject.S_OK, data.GetData(ref requested, out StgMedium first));
            Assert.Equal(FileDropDataObject.S_OK, data.GetData(ref requested, out StgMedium second));
            try
            {
                Assert.NotEqual(first.unionMember, second.unionMember);
                Assert.Equal(IntPtr.Zero, first.pUnkForRelease);
                Assert.Equal(IntPtr.Zero, second.pUnkForRelease);
            }
            finally
            {
                ReleaseStgMedium(ref first);
                ReleaseStgMedium(ref second);
            }

            Assert.Equal(FileDropFormatEnumerator.S_FALSE, formats.Next(1, discovered, fetched));
            Assert.Equal(0, fetched[0]);
        }
        finally
        {
            if (Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
            Marshal.Release(pointer);
        }
    }

    [Fact]
    public void FormatEnumerator_ResetSkipAndClonePreserveSequencePosition()
    {
        var original = new FileDropFormatEnumerator();
        int[] fetched = [-1];

        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Next(0, [], fetched));
        Assert.Equal(0, fetched[0]);
        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Skip(0));

        original.Clone(out IEnumFORMATETC initialClone);
        AssertNextItem(initialClone);

        AssertNextItem(original);
        original.Clone(out IEnumFORMATETC advancedClone);
        AssertEnd(advancedClone);

        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Reset());
        AssertNextItem(original);
        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Reset());
        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Skip(1));
        AssertEnd(original);

        Assert.Equal(FileDropFormatEnumerator.S_OK, original.Reset());
        Assert.Equal(FileDropFormatEnumerator.S_FALSE, original.Skip(2));
        AssertEnd(original);
        Assert.Equal(FileDropFormatEnumerator.S_FALSE, original.Skip(1));

        var batched = new FileDropFormatEnumerator();
        FORMATETC[] formats = new FORMATETC[2];
        Assert.Equal(FileDropFormatEnumerator.S_FALSE, batched.Next(2, formats, fetched));
        Assert.Equal(1, fetched[0]);
        Assert.Equal(FileDropHGlobal.CfHDrop, formats[0].cfFormat);
    }

    [Fact]
    public void EnumFormatEtc_RejectsSetAndInvalidDirectionsWithoutAnEnumerator()
    {
        var data = new FileDropDataObject([@"C:\stage\one.png"]);

        Assert.Equal(FileDropDataObject.E_NOTIMPL,
            data.EnumFormatEtc(FileDropDataObject.DatadirSet, out IntPtr setEnumerator));
        Assert.Equal(IntPtr.Zero, setEnumerator);
        Assert.Equal(FileDropDataObject.E_INVALIDARG,
            data.EnumFormatEtc(0, out IntPtr invalidEnumerator));
        Assert.Equal(IntPtr.Zero, invalidEnumerator);
    }

    [Fact]
    public void ManagedObjects_ExposeTheRequiredOleInterfaces()
    {
        IntPtr data = Marshal.GetComInterfaceForObject(
            new FileDropDataObject([@"C:\stage\one.png"]), typeof(IFileDropDataObject));
        IntPtr source = Marshal.GetComInterfaceForObject(new FileDragDropSource(), typeof(IFileDragDropSource));
        try
        {
            Assert.NotEqual(IntPtr.Zero, data);
            Assert.NotEqual(IntPtr.Zero, source);
        }
        finally
        {
            if (data != IntPtr.Zero) Marshal.Release(data);
            if (source != IntPtr.Zero) Marshal.Release(source);
        }
    }

    [Fact]
    public void GetData_AllocationFailureTransfersNothing()
    {
        var data = new FileDropDataObject([@"C:\stage\one.png"], _ => IntPtr.Zero);
        FormatEtc format = ValidFormat();

        Assert.Equal(FileDropDataObject.E_OUTOFMEMORY, data.GetData(ref format, out StgMedium medium));
        Assert.Equal(default, medium.unionMember);
        Assert.Equal(default, medium.tymed);
    }

    [Fact]
    public void DropSource_UsesLeftButtonEscapeAndDefaultCursorContracts()
    {
        var source = new FileDragDropSource();
        Assert.Equal(FileDragDropSource.S_OK, source.QueryContinueDrag(false, FileDragDropSource.MkLeftButton));
        Assert.Equal(FileDragDropSource.DragDropSDrop, source.QueryContinueDrag(false, 0));
        Assert.Equal(FileDragDropSource.DragDropSCancel, source.QueryContinueDrag(true, FileDragDropSource.MkLeftButton));
        Assert.Equal(FileDragDropSource.DragDropSUseDefaultCursors, source.GiveFeedback(WindowsFileDrag.DropEffectCopy));
    }

    [Fact]
    public void DoDragDrop_OffersCopyOnlyAndClassifiesNativeResultsStrictly()
    {
        var native = new RecordingDragNative(FileDragDropSource.DragDropSDrop, WindowsFileDrag.DropEffectCopy);
        Assert.Equal(FileDragResult.Copied, WindowsFileDrag.Run([@"C:\stage\one.png"], native));
        Assert.Equal(WindowsFileDrag.DropEffectCopy, native.AllowedEffects);
        Assert.Equal(FileDragResult.Rejected, WindowsFileDrag.Classify(FileDragDropSource.DragDropSDrop, 0));
        Assert.Equal(FileDragResult.Cancelled, WindowsFileDrag.Classify(FileDragDropSource.DragDropSCancel, 0));
        Assert.Equal(FileDragResult.Failed, WindowsFileDrag.Classify(unchecked((int)0x80004005), 0));
    }

    [Fact]
    public void OleLifetime_BalancesOnlySuccessfulInitialization()
    {
        int uninitializations = 0;
        OleThreadLifetime.Initialize(() => 0, () => uninitializations++).Dispose();
        OleThreadLifetime.Initialize(() => 1, () => uninitializations++).Dispose();
        OleThreadLifetime.Initialize(() => OleThreadLifetime.RpcEChangedMode, () => uninitializations++).Dispose();
        OleThreadLifetime.Initialize(() => unchecked((int)0x80004005), () => uninitializations++).Dispose();
        Assert.Equal(2, uninitializations);
    }

    private static FormatEtc ValidFormat() => new()
    {
        cfFormat = FileDropHGlobal.CfHDrop,
        dwAspect = 1,
        lindex = -1,
        tymed = FileDropDataObject.TymedHGlobal,
    };

    private static FormatEtc FromComFormat(FORMATETC format) => new()
    {
        cfFormat = format.cfFormat,
        ptd = format.ptd,
        dwAspect = (uint)format.dwAspect,
        lindex = format.lindex,
        tymed = (uint)format.tymed,
    };

    private static void AssertNextItem(IEnumFORMATETC enumerator)
    {
        var formats = new FORMATETC[1];
        int[] fetched = new int[1];
        Assert.Equal(FileDropFormatEnumerator.S_OK, enumerator.Next(1, formats, fetched));
        Assert.Equal(1, fetched[0]);
        Assert.Equal(FileDropHGlobal.CfHDrop, formats[0].cfFormat);
    }

    private static void AssertEnd(IEnumFORMATETC enumerator)
    {
        var formats = new FORMATETC[1];
        int[] fetched = new int[1];
        Assert.Equal(FileDropFormatEnumerator.S_FALSE, enumerator.Next(1, formats, fetched));
        Assert.Equal(0, fetched[0]);
    }

    private static byte[] ReadGlobal(IntPtr memory)
    {
        int size = checked((int)GlobalSize(memory).ToUInt64());
        IntPtr locked = GlobalLock(memory);
        Assert.NotEqual(IntPtr.Zero, locked);
        try { var bytes = new byte[size]; Marshal.Copy(locked, bytes, 0, size); return bytes; }
        finally { GlobalUnlock(memory); }
    }

    private sealed class RecordingDragNative(int result, uint effect) : IFileDragNative
    {
        public uint AllowedEffects { get; private set; }
        public int DoDragDrop(IFileDropDataObject data, IFileDragDropSource source, uint allowedEffects, out uint returnedEffect)
        {
            AllowedEffects = allowedEffects;
            returnedEffect = effect;
            return result;
        }
    }

    [DllImport("kernel32.dll")] private static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")] private static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("ole32.dll")] private static extern void ReleaseStgMedium(ref StgMedium medium);
}
