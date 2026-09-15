using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace OpenLocally;

internal enum NativePreviewOutcome { Thumbnail, PreviewAccessFailed, ExtractionFailed, ComUnavailable }

internal sealed record NativePreviewCacheKey(
    long AssetId, StagedMediaProvenance Provenance, string Path, long ExpectedSize, int PixelSize,
    ManualPreviewFileCacheIdentity FileIdentity);

internal sealed record NativePreviewRequest(
    long Generation, int PlatformIndex, string Platform, int Ordinal,
    ManualPreparedAsset Prepared, int PixelSize);

internal sealed record NativePreviewResult(
    NativePreviewRequest Request, NativePreviewOutcome Outcome, NativeThumbnailPixels? Pixels);

internal sealed record NativeThumbnailPixels(int Width, int Height, byte[] Bgra)
{
    public NativeThumbnailPixels Copy() => new(Width, Height, (byte[])Bgra.Clone());
}

internal interface INativeShellThumbnailExtractor
{
    NativeThumbnailPixels? TryExtract(string path, int pixelSize);
}

internal interface INativePreviewWorkerApartment
{
    IDisposable? TryEnter();
}

internal sealed record NativePreviewPipelineTestHooks(
    Action? BeforeAcceptanceLock = null,
    Action? BeforeNotificationReset = null,
    Func<Thread, bool>? ConfigureWorkerApartment = null,
    Action<int, ApartmentState>? WorkerApartmentEntered = null,
    Action<int>? WorkerApartmentExited = null);

/// <summary>Small session-only LRU containing copied pixels, never file leases or native handles.</summary>
internal sealed class NativePreviewCache : IDisposable
{
    private readonly int _capacity;
    private readonly Dictionary<NativePreviewCacheKey, LinkedListNode<Entry>> _entries = [];
    private readonly LinkedList<Entry> _lru = [];
    private readonly object _gate = new();
    private bool _disposed;

    public NativePreviewCache(int capacity = 128) => _capacity = Math.Max(1, capacity);

    public bool TryGet(NativePreviewCacheKey key, out NativeThumbnailPixels? pixels)
    {
        lock (_gate)
        {
            if (!_disposed && _entries.TryGetValue(key, out LinkedListNode<Entry>? node))
            {
                _lru.Remove(node);
                _lru.AddFirst(node);
                pixels = node.Value.Pixels.Copy();
                return true;
            }
        }
        pixels = null;
        return false;
    }

    public void Store(NativePreviewCacheKey key, NativeThumbnailPixels pixels)
    {
        lock (_gate)
        {
            if (_disposed) return;
            if (_entries.Remove(key, out LinkedListNode<Entry>? existing)) _lru.Remove(existing);
            var node = new LinkedListNode<Entry>(new(key, pixels.Copy()));
            _lru.AddFirst(node);
            _entries[key] = node;
            while (_entries.Count > _capacity)
            {
                LinkedListNode<Entry> last = _lru.Last!;
                _lru.RemoveLast();
                _entries.Remove(last.Value.Key);
            }
        }
    }

    internal int Count { get { lock (_gate) return _entries.Count; } }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
            _entries.Clear();
            _lru.Clear();
        }
    }

    private sealed record Entry(NativePreviewCacheKey Key, NativeThumbnailPixels Pixels);
}

/// <summary>Two dedicated COM workers; each extraction owns exactly one WP9D preview lease.</summary>
internal sealed class NativeAssetPreviewPipeline : IAsyncDisposable
{
    internal const int WorkerCount = 2;
    internal const int QueueCapacity = 256;
    internal const int ResultCapacity = 64;
    internal const int OutstandingCapacity = 256;
    private readonly IManualAssetPreviewAccess _access;
    private readonly INativeShellThumbnailExtractor _extractor;
    private readonly INativePreviewWorkerApartment _apartment;
    private readonly Func<bool> _signalResults;
    private readonly NativePreviewPipelineTestHooks? _testHooks;
    private readonly object _lifecycleGate = new();
    private readonly BlockingCollection<NativePreviewRequest> _requests = new(QueueCapacity);
    private readonly BlockingCollection<NativePreviewResult> _results = new(ResultCapacity);
    private readonly Thread[] _workers;
    private int _stopping;
    private int _disposed;
    private int _outstanding;
    private int _maximumOutstanding;
    private int _notificationPending;
    private readonly bool _workersAvailable;

    public NativeAssetPreviewPipeline(
        IManualAssetPreviewAccess access, Func<bool> signalResults,
        INativeShellThumbnailExtractor? extractor = null,
        INativePreviewWorkerApartment? apartment = null,
        NativePreviewCache? cache = null,
        NativePreviewPipelineTestHooks? testHooks = null)
    {
        _access = access ?? throw new ArgumentNullException(nameof(access));
        _signalResults = signalResults ?? throw new ArgumentNullException(nameof(signalResults));
        _extractor = extractor ?? new NativeShellThumbnailExtractor();
        _apartment = apartment ?? new NativePreviewWorkerApartment();
        _testHooks = testHooks;
        Cache = cache ?? new NativePreviewCache();
        Thread[] workers = Enumerable.Range(0, WorkerCount).Select(index =>
        {
            return new Thread(WorkerLoop)
            {
                IsBackground = true,
                Name = $"CreatorCrate thumbnail {index + 1}",
            };
        }).ToArray();
        try
        {
            Func<Thread, bool> configureApartment = _testHooks?.ConfigureWorkerApartment ??
                (thread => thread.TrySetApartmentState(ApartmentState.STA));
            _workersAvailable = workers.All(configureApartment);
        }
        catch
        {
            _workersAvailable = false;
        }
        _workers = _workersAvailable ? workers : [];
        foreach (Thread worker in _workers) worker.Start();
    }

    public NativePreviewCache Cache { get; }

    internal int OutstandingCount => Volatile.Read(ref _outstanding);
    internal int MaximumOutstandingCount => Volatile.Read(ref _maximumOutstanding);
    internal int ResultCount => Volatile.Read(ref _disposed) != 0 ? 0 : _results.Count;
    internal bool NotificationPending => Volatile.Read(ref _notificationPending) != 0;

    public bool TrySchedule(NativePreviewRequest request)
    {
        if (!_workersAvailable || Volatile.Read(ref _stopping) != 0) return false;
        _testHooks?.BeforeAcceptanceLock?.Invoke();
        lock (_lifecycleGate)
        {
            if (_stopping != 0 || _disposed != 0 || _outstanding >= OutstandingCapacity) return false;
            int outstanding = Interlocked.Increment(ref _outstanding);
            UpdateMaximumOutstanding(outstanding);
            if (_requests.TryAdd(request)) return true;
            ReleaseOutstanding();
            return false;
        }
    }

    public int DrainResults(Action<NativePreviewResult> consume, int maximum = ResultCapacity)
    {
        ArgumentNullException.ThrowIfNull(consume);
        int drained = 0;
        try
        {
            while (drained < Math.Max(1, maximum) && _results.TryTake(out NativePreviewResult? result))
            {
                try { consume(result); }
                finally { ReleaseOutstanding(); }
                drained++;
            }
        }
        finally { RearmNotification(); }
        return drained;
    }

    public void BeginClose()
    {
        lock (_lifecycleGate)
        {
            if (_stopping != 0) return;
            Volatile.Write(ref _stopping, 1);
            _requests.CompleteAdding();
        }
        while (_requests.TryTake(out _)) ReleaseOutstanding();
        DiscardResults();
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        BeginClose();
        await Task.Run(() =>
        {
            foreach (Thread worker in _workers) worker.Join();
        }).ConfigureAwait(false);
        while (_requests.TryTake(out _)) ReleaseOutstanding();
        DiscardResults();
        Cache.Dispose();
        _access.Dispose();
        _results.Dispose();
        _requests.Dispose();
    }

    private void WorkerLoop()
    {
        IDisposable? initialized;
        try { initialized = _apartment.TryEnter(); }
        catch { initialized = null; }
        _testHooks?.WorkerApartmentEntered?.Invoke(
            Environment.CurrentManagedThreadId, Thread.CurrentThread.GetApartmentState());
        try
        {
            while (Volatile.Read(ref _stopping) == 0 && _requests.TryTake(out NativePreviewRequest? request, Timeout.Infinite))
            {
                NativePreviewResult result = Extract(request, initialized is not null);
                bool retained;
                lock (_lifecycleGate)
                    retained = _stopping == 0 && _results.TryAdd(result);
                if (!retained)
                {
                    ReleaseOutstanding();
                    continue;
                }
                SignalResultsAvailable();
            }
        }
        finally
        {
            initialized?.Dispose();
            _testHooks?.WorkerApartmentExited?.Invoke(Environment.CurrentManagedThreadId);
        }
    }

    private void SignalResultsAvailable()
    {
        if (Interlocked.Exchange(ref _notificationPending, 1) != 0) return;
        bool posted;
        try { posted = _signalResults(); }
        catch { posted = false; }
        if (posted) return;
        Interlocked.Exchange(ref _notificationPending, 0);
        DiscardResults();
    }

    private void RearmNotification()
    {
        _testHooks?.BeforeNotificationReset?.Invoke();
        Interlocked.Exchange(ref _notificationPending, 0);
        if (!_results.IsCompleted && _results.Count != 0) SignalResultsAvailable();
    }

    private void DiscardResults()
    {
        while (_results.TryTake(out _)) ReleaseOutstanding();
        Interlocked.Exchange(ref _notificationPending, 0);
    }

    private void ReleaseOutstanding()
    {
        int remaining = Interlocked.Decrement(ref _outstanding);
        if (remaining < 0) throw new InvalidOperationException("Preview outstanding-work accounting underflowed.");
    }

    private void UpdateMaximumOutstanding(int outstanding)
    {
        int observed;
        while (outstanding > (observed = Volatile.Read(ref _maximumOutstanding)) &&
            Interlocked.CompareExchange(ref _maximumOutstanding, outstanding, observed) != observed) { }
    }

    private NativePreviewResult Extract(NativePreviewRequest request, bool shellAvailable)
    {
        try
        {
            ManualPreviewAccessResult access = _access.TryAcquireRead(request.Prepared, request.Ordinal);
            if (!access.Success || access.Lease is null)
                return new(request, NativePreviewOutcome.PreviewAccessFailed, null);
            using (access.Lease)
            {
                NativePreviewCacheKey? cacheKey = CreateCacheKey(request, access.Lease);
                if (cacheKey is not null && Cache.TryGet(cacheKey, out NativeThumbnailPixels? cached) && cached is not null)
                    return new(request, NativePreviewOutcome.Thumbnail, cached);
                if (!shellAvailable) return new(request, NativePreviewOutcome.ComUnavailable, null);
                NativeThumbnailPixels? pixels = _extractor.TryExtract(access.Lease.Path, request.PixelSize);
                if (pixels is null) return new(request, NativePreviewOutcome.ExtractionFailed, null);
                if (cacheKey is not null) Cache.Store(cacheKey, pixels);
                return new(request, NativePreviewOutcome.Thumbnail, pixels);
            }
        }
        catch
        {
            return new(request, NativePreviewOutcome.ExtractionFailed, null);
        }
    }

    internal static NativePreviewCacheKey? CreateCacheKey(
        NativePreviewRequest request, ManualPreviewFileLease lease)
    {
        if (lease.CacheIdentity is not ManualPreviewFileCacheIdentity fileIdentity) return null;
        string path;
        try { path = Path.GetFullPath(lease.Path).ToUpperInvariant(); }
        catch { path = lease.Path.ToUpperInvariant(); }
        return new NativePreviewCacheKey(
            lease.AssetId, lease.Provenance, path, request.Prepared.Asset.SizeBytes, request.PixelSize, fileIdentity);
    }
}

internal sealed class NativePreviewWorkerApartment : INativePreviewWorkerApartment
{
    private const uint CoinitApartmentThreaded = 0x2;
    private readonly Func<uint, int> _initialize;
    private readonly Action _uninitialize;

    public NativePreviewWorkerApartment()
        : this(model => CoInitializeEx(IntPtr.Zero, model), CoUninitialize) { }

    internal NativePreviewWorkerApartment(Func<uint, int> initialize, Action uninitialize) =>
        (_initialize, _uninitialize) = (initialize, uninitialize);

    public IDisposable? TryEnter()
    {
        int result = _initialize(CoinitApartmentThreaded);
        return result is 0 or 1 ? new Scope(_uninitialize) : null;
    }

    private sealed class Scope(Action uninitialize) : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0) uninitialize();
        }
    }

    [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint concurrencyModel);
    [DllImport("ole32.dll")] private static extern void CoUninitialize();
}

internal sealed class NativeShellThumbnailExtractor : INativeShellThumbnailExtractor
{
    private const uint SiigbfResizeToFit = 0x00;
    private const uint SiigbfThumbnailOnly = 0x08;
    private const uint DibRgbColors = 0;
    private static readonly Guid ImageFactoryId = new("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    private readonly NativeShellThumbnailTestHooks? _testHooks;

    public NativeShellThumbnailExtractor() { }
    internal NativeShellThumbnailExtractor(NativeShellThumbnailTestHooks testHooks) => _testHooks = testHooks;

    public NativeThumbnailPixels? TryExtract(string path, int pixelSize)
    {
        IShellItemImageFactory? factory = null;
        IntPtr bitmap = IntPtr.Zero;
        try
        {
            Guid iid = ImageFactoryId;
            int created = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out factory);
            _testHooks?.ShellItemCreated?.Invoke(created);
            if (created < 0 || factory is null) return null;
            int fetched = factory.GetImage(
                new NativeSize { cx = pixelSize, cy = pixelSize },
                SiigbfResizeToFit | SiigbfThumbnailOnly,
                out bitmap);
            _testHooks?.ImageFetched?.Invoke(fetched, bitmap);
            if (fetched < 0 || bitmap == IntPtr.Zero) return null;
            NativeThumbnailPixels? pixels = CopyPixels(bitmap, pixelSize);
            _testHooks?.PixelsCopied?.Invoke(pixels is not null);
            return pixels;
        }
        catch { return null; }
        finally
        {
            if (bitmap != IntPtr.Zero)
            {
                DeleteObject(bitmap);
                _testHooks?.BitmapReleased();
            }
            if (factory is not null && Marshal.IsComObject(factory))
            {
                Marshal.FinalReleaseComObject(factory);
                _testHooks?.ComInterfaceReleased();
            }
        }
    }

    private static NativeThumbnailPixels? CopyPixels(IntPtr bitmap, int requestedSize)
    {
        if (GetObject(bitmap, Marshal.SizeOf<NativeBitmap>(), out NativeBitmap source) == 0 ||
            source.bmWidth <= 0 || source.bmHeight == 0) return null;
        int width = source.bmWidth;
        int height = Math.Abs(source.bmHeight);
        int stride = checked(width * 4);
        byte[] sourcePixels = new byte[checked(stride * height)];
        var info = new BitmapInfo
        {
            Header = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(), Width = width, Height = -height,
                Planes = 1, BitCount = 32, Compression = 0,
            },
        };
        IntPtr screen = GetDC(IntPtr.Zero);
        if (screen == IntPtr.Zero) return null;
        try
        {
            if (GetDIBits(screen, bitmap, 0, (uint)height, sourcePixels, ref info, DibRgbColors) == 0) return null;
        }
        finally { ReleaseDC(IntPtr.Zero, screen); }

        bool hasAlpha = false;
        for (int index = 3; index < sourcePixels.Length; index += 4)
            if (sourcePixels[index] != 0) { hasAlpha = true; break; }
        if (!hasAlpha)
            for (int index = 3; index < sourcePixels.Length; index += 4) sourcePixels[index] = 255;

        int canvasSize = Math.Max(1, requestedSize);
        byte[] canvas = new byte[checked(canvasSize * canvasSize * 4)];
        int copyWidth = Math.Min(width, canvasSize);
        int copyHeight = Math.Min(height, canvasSize);
        int sourceX = Math.Max(0, (width - copyWidth) / 2);
        int sourceY = Math.Max(0, (height - copyHeight) / 2);
        int targetX = Math.Max(0, (canvasSize - copyWidth) / 2);
        int targetY = Math.Max(0, (canvasSize - copyHeight) / 2);
        for (int row = 0; row < copyHeight; row++)
            Buffer.BlockCopy(sourcePixels, ((sourceY + row) * width + sourceX) * 4,
                canvas, ((targetY + row) * canvasSize + targetX) * 4, copyWidth * 4);
        return new NativeThumbnailPixels(canvasSize, canvasSize, canvas);
    }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItemImageFactory
    {
        [PreserveSig] int GetImage(NativeSize size, uint flags, out IntPtr bitmap);
    }

    [StructLayout(LayoutKind.Sequential)] private struct NativeSize { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)] private struct NativeBitmap
    {
        public int bmType, bmWidth, bmHeight, bmWidthBytes;
        public ushort bmPlanes, bmBitsPixel;
        public IntPtr bmBits;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ClrUsed, ClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo
    {
        public BitmapInfoHeader Header;
        public uint Colors;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        string path, IntPtr bindContext, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory? factory);
    [DllImport("gdi32.dll")] private static extern int GetObject(IntPtr value, int size, out NativeBitmap bitmap);
    [DllImport("gdi32.dll")] private static extern int GetDIBits(
        IntPtr device, IntPtr bitmap, uint start, uint lines, [Out] byte[] bits, ref BitmapInfo info, uint usage);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr device);
}

internal sealed record NativeShellThumbnailTestHooks(
    Action BitmapReleased,
    Action ComInterfaceReleased,
    Action<int>? ShellItemCreated = null,
    Action<int, IntPtr>? ImageFetched = null,
    Action<bool>? PixelsCopied = null);

internal static class NativePreviewPlaceholders
{
    public static NativeThumbnailPixels Create(int size, int color, bool unavailable, bool failed)
    {
        size = Math.Max(16, size);
        byte[] pixels = new byte[size * size * 4];
        (byte red, byte green, byte blue) = ((byte)(color & 0xff), (byte)((color >> 8) & 0xff), (byte)((color >> 16) & 0xff));
        void Pixel(int x, int y)
        {
            if ((uint)x >= size || (uint)y >= size) return;
            int offset = (y * size + x) * 4;
            pixels[offset] = blue; pixels[offset + 1] = green; pixels[offset + 2] = red; pixels[offset + 3] = 255;
        }
        int left = size / 4, top = size / 6, right = size - size / 4 - 1, bottom = size - size / 6 - 1;
        int fold = Math.Max(3, size / 6);
        for (int x = left; x <= right - fold; x++) Pixel(x, top);
        for (int x = left; x <= right; x++) Pixel(x, bottom);
        for (int y = top; y <= bottom; y++) { Pixel(left, y); Pixel(right, y); }
        for (int step = 0; step <= fold; step++) { Pixel(right - fold + step, top + step); Pixel(right - fold + step, top); }
        if (unavailable)
            for (int x = left + 4; x <= right - 4; x++) { Pixel(x, size / 2); Pixel(x, size / 2 + 1); }
        if (failed)
            for (int step = 0; step < Math.Max(5, size / 4); step++)
            {
                Pixel(size / 2 - step, size / 2 - step); Pixel(size / 2 + step, size / 2 + step);
                Pixel(size / 2 - step, size / 2 + step); Pixel(size / 2 + step, size / 2 - step);
            }
        return new NativeThumbnailPixels(size, size, pixels);
    }
}

internal static class NativeImageListStorage
{
    private const uint IlcColor32 = 0x20;
    private const uint DibRgbColors = 0;

    public static IntPtr Create(int pixelSize, int initialCount = 8) =>
        ImageList_Create(pixelSize, pixelSize, IlcColor32, initialCount, 8);

    public static int Add(IntPtr imageList, NativeThumbnailPixels pixels)
    {
        if (imageList == IntPtr.Zero || pixels.Width <= 0 || pixels.Height <= 0 ||
            pixels.Bgra.Length != pixels.Width * pixels.Height * 4) return -1;
        var info = new BitmapInfo
        {
            Header = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf<BitmapInfoHeader>(), Width = pixels.Width, Height = -pixels.Height,
                Planes = 1, BitCount = 32, Compression = 0,
            },
        };
        IntPtr device = GetDC(IntPtr.Zero);
        if (device == IntPtr.Zero) return -1;
        IntPtr bitmap = IntPtr.Zero;
        try
        {
            bitmap = CreateDIBSection(device, ref info, DibRgbColors, out IntPtr bits, IntPtr.Zero, 0);
            if (bitmap == IntPtr.Zero || bits == IntPtr.Zero) return -1;
            Marshal.Copy(pixels.Bgra, 0, bits, pixels.Bgra.Length);
            return ImageList_Add(imageList, bitmap, IntPtr.Zero);
        }
        finally
        {
            if (bitmap != IntPtr.Zero) DeleteObject(bitmap);
            ReleaseDC(IntPtr.Zero, device);
        }
    }

    public static void Destroy(IntPtr imageList)
    {
        if (imageList != IntPtr.Zero) ImageList_Destroy(imageList);
    }

    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width, Height;
        public ushort Planes, BitCount;
        public uint Compression, SizeImage;
        public int XPelsPerMeter, YPelsPerMeter;
        public uint ClrUsed, ClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)] private struct BitmapInfo
    {
        public BitmapInfoHeader Header;
        public uint Colors;
    }

    [DllImport("comctl32.dll")] private static extern IntPtr ImageList_Create(int cx, int cy, uint flags, int initial, int grow);
    [DllImport("comctl32.dll")] private static extern int ImageList_Add(IntPtr imageList, IntPtr bitmap, IntPtr mask);
    [DllImport("comctl32.dll")] private static extern bool ImageList_Destroy(IntPtr imageList);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateDIBSection(
        IntPtr device, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr value);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr window, IntPtr device);
}
