using System.Runtime.InteropServices;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage;

internal static class CompositorWindowCapture
{
    private const uint D3D11CreateDeviceBgraSupport = 0x20;
    private const uint D3D11SdkVersion = 7;
    private const int D3DDriverTypeHardware = 1;
    private const int D3DDriverTypeWarp = 5;
    private static readonly Guid GraphicsCaptureItemId = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");
    private static readonly Guid DxgiDeviceId = new("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
    private static readonly Guid GraphicsCaptureItemInteropId = new("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356");

    internal static async Task CaptureAsync(IntPtr window, string path, CancellationToken cancellationToken = default)
    {
        string fullPath = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);

        GraphicsCaptureItem item = CreateItemForWindow(window);
        IDirect3DDevice device = CreateDirect3DDevice();
        try
        {
            using Direct3D11CaptureFramePool framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                device,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                item.Size);
            using GraphicsCaptureSession session = framePool.CreateCaptureSession(item);
            var frameReady = new TaskCompletionSource<Direct3D11CaptureFrame>(
                TaskCreationOptions.RunContinuationsAsynchronously);

            void OnFrameArrived(Direct3D11CaptureFramePool sender, object _)
            {
                Direct3D11CaptureFrame? frame = sender.TryGetNextFrame();
                if (!frameReady.TrySetResult(frame)) frame.Dispose();
            }

            framePool.FrameArrived += OnFrameArrived;
            try
            {
                session.StartCapture();
                using Direct3D11CaptureFrame frame = await frameReady.Task
                    .WaitAsync(TimeSpan.FromSeconds(10), cancellationToken)
                    .ConfigureAwait(false);
                using SoftwareBitmap bitmap = await SoftwareBitmap
                    .CreateCopyFromSurfaceAsync(frame.Surface)
                    .AsTask(cancellationToken)
                    .ConfigureAwait(false);

                using (File.Create(fullPath)) { }
                StorageFile file = await StorageFile.GetFileFromPathAsync(fullPath)
                    .AsTask(cancellationToken)
                    .ConfigureAwait(false);
                using var stream = await file.OpenAsync(FileAccessMode.ReadWrite)
                    .AsTask(cancellationToken)
                    .ConfigureAwait(false);
                BitmapEncoder encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.PngEncoderId, stream)
                    .AsTask(cancellationToken)
                    .ConfigureAwait(false);
                encoder.SetSoftwareBitmap(bitmap);
                await encoder.FlushAsync().AsTask(cancellationToken).ConfigureAwait(false);
                Console.WriteLine(
                    $"capture={fullPath}; mechanism=Windows.Graphics.Capture; " +
                    $"width={frame.ContentSize.Width}; height={frame.ContentSize.Height}");
            }
            finally { framePool.FrameArrived -= OnFrameArrived; }
        }
        finally
        {
            if (device is IDisposable disposable) disposable.Dispose();
        }
    }

    private static GraphicsCaptureItem CreateItemForWindow(IntPtr window)
    {
        using WinRT.IObjectReference factory = WinRT.ActivationFactory.Get(
            "Windows.Graphics.Capture.GraphicsCaptureItem",
            GraphicsCaptureItemInteropId);
        IntPtr virtualTable = Marshal.ReadIntPtr(factory.ThisPtr);
        IntPtr createForWindowPointer = Marshal.ReadIntPtr(virtualTable, 3 * IntPtr.Size);
        var createForWindow = Marshal.GetDelegateForFunctionPointer<CreateForWindowDelegate>(
            createForWindowPointer);
        Guid itemId = GraphicsCaptureItemId;
        int hresult = createForWindow(factory.ThisPtr, window, ref itemId, out IntPtr itemPointer);
        Marshal.ThrowExceptionForHR(hresult);
        try
        {
            return WinRT.MarshalInspectable<GraphicsCaptureItem>.FromAbi(itemPointer);
        }
        finally { Marshal.Release(itemPointer); }
    }

    private static IDirect3DDevice CreateDirect3DDevice()
    {
        int hresult = D3D11CreateDevice(
            IntPtr.Zero,
            D3DDriverTypeHardware,
            IntPtr.Zero,
            D3D11CreateDeviceBgraSupport,
            IntPtr.Zero,
            0,
            D3D11SdkVersion,
            out IntPtr d3dDevice,
            out _,
            out IntPtr immediateContext);
        if (hresult < 0)
        {
            hresult = D3D11CreateDevice(
                IntPtr.Zero,
                D3DDriverTypeWarp,
                IntPtr.Zero,
                D3D11CreateDeviceBgraSupport,
                IntPtr.Zero,
                0,
                D3D11SdkVersion,
                out d3dDevice,
                out _,
                out immediateContext);
        }
        Marshal.ThrowExceptionForHR(hresult);
        try
        {
            Guid dxgiDeviceId = DxgiDeviceId;
            hresult = Marshal.QueryInterface(d3dDevice, in dxgiDeviceId, out IntPtr dxgiDevice);
            Marshal.ThrowExceptionForHR(hresult);
            try
            {
                hresult = CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice, out IntPtr inspectable);
                Marshal.ThrowExceptionForHR(hresult);
                try { return WinRT.MarshalInterface<IDirect3DDevice>.FromAbi(inspectable); }
                finally { Marshal.Release(inspectable); }
            }
            finally { Marshal.Release(dxgiDevice); }
        }
        finally
        {
            if (immediateContext != IntPtr.Zero) Marshal.Release(immediateContext);
            if (d3dDevice != IntPtr.Zero) Marshal.Release(d3dDevice);
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int CreateForWindowDelegate(
        IntPtr thisPointer,
        IntPtr window,
        ref Guid iid,
        out IntPtr result);

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int D3D11CreateDevice(
        IntPtr adapter,
        int driverType,
        IntPtr software,
        uint flags,
        IntPtr featureLevels,
        uint featureLevelCount,
        uint sdkVersion,
        out IntPtr device,
        out int featureLevel,
        out IntPtr immediateContext);

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(
        IntPtr dxgiDevice,
        out IntPtr graphicsDevice);
}
