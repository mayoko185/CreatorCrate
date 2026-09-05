using OpenLocally;

namespace OpenLocally.Tests;

public class ChromeDiscoveryTests
{
    [Fact]
    public void Discover_UsesStableChromePathAndBuildsLoopbackEndpoint()
    {
        var environment = new FakeEnvironment(running: true, localAppData: @"C:\Users\operator\AppData\Local");
        var file = new FakeFile("15123\n/devtools/browser/new-browser-id\n");
        var discovery = new ChromeDiscovery(environment, file);

        ChromeDiscoveryResult result = discovery.Discover();

        Assert.True(result.Success);
        Assert.Equal(@"C:\Users\operator\AppData\Local\Google\Chrome\User Data\DevToolsActivePort", file.Paths.Single());
        Assert.Equal("ws://127.0.0.1:15123/devtools/browser/new-browser-id", result.Endpoint!.Uri.AbsoluteUri);
        Assert.Equal("127.0.0.1", result.Endpoint.Uri.Host);
        Assert.Equal("ws", result.Endpoint.Uri.Scheme);
    }

    [Fact]
    public void Discover_ReReadsFileAndNeverCachesBrowserId()
    {
        var file = new FakeFile(
            "1\n/devtools/browser/first\n",
            "65535\n/devtools/browser/second\n");
        var discovery = new ChromeDiscovery(new FakeEnvironment(true, @"C:\Local"), file);

        ChromeDiscoveryResult first = discovery.Discover();
        ChromeDiscoveryResult second = discovery.Discover();

        Assert.Equal("/devtools/browser/first", first.Endpoint!.BrowserPath);
        Assert.Equal("/devtools/browser/second", second.Endpoint!.BrowserPath);
        Assert.Equal(2, file.ReadCalls);
    }

    [Fact]
    public void Discover_ReportsNoChromeBeforeReadingFile()
    {
        var file = new FakeFile("9222\n/devtools/browser/id\n");

        ChromeDiscoveryResult result = new ChromeDiscovery(new FakeEnvironment(false, @"C:\Local"), file).Discover();

        Assert.False(result.Success);
        Assert.Equal("chrome_not_running", result.ErrorCode);
        Assert.Equal(0, file.ReadCalls);
    }

    [Fact]
    public void Discover_ReportsMissingWhenEnvironmentOrFileIsMissing()
    {
        Assert.Equal(
            "chrome_discovery_missing",
            new ChromeDiscovery(new FakeEnvironment(true, null), new FakeFile()).Discover().ErrorCode);
        Assert.Equal(
            "chrome_discovery_missing",
            new ChromeDiscovery(new FakeEnvironment(true, @"C:\Local"), new FakeFile((string?)null)).Discover().ErrorCode);
    }

    [Theory]
    [InlineData("1\n/devtools/browser/one\n", 1)]
    [InlineData("65535\n/devtools/browser/two\n", 65535)]
    public void TryParse_AcceptsBoundaryPorts(string content, int expectedPort)
    {
        Assert.True(ChromeDiscovery.TryParse(content, out ChromeEndpoint? endpoint));
        Assert.Equal(expectedPort, endpoint!.Port);
    }

    [Theory]
    [InlineData("0\n/devtools/browser/id\n")]
    [InlineData("65536\n/devtools/browser/id\n")]
    [InlineData("not-a-port\n/devtools/browser/id\n")]
    [InlineData("\n/devtools/browser/id\n")]
    [InlineData("9222\n\n")]
    [InlineData("9222\n/devtools/page/id\n")]
    [InlineData("9222\nws://192.168.1.8:9222/devtools/browser/id\n")]
    [InlineData("9222\n/devtools/browser/id?query\n")]
    [InlineData("9222\n/devtools/browser/../id\n")]
    [InlineData("9222\n/devtools/browser/id\u0001\n")]
    [InlineData("9222\n/devtools/browser/id\nextra")]
    public void TryParse_RejectsMalformedDiscovery(string content)
    {
        Assert.False(ChromeDiscovery.TryParse(content, out _));
    }

    [Fact]
    public void TryParse_RejectsExcessiveContent()
    {
        string content = "9222\n/devtools/browser/id\n" + new string('x', ChromeDiscovery.MaximumDiscoveryCharacters);

        Assert.False(ChromeDiscovery.TryParse(content, out _));
    }

    private sealed class FakeEnvironment(bool running, string? localAppData) : IChromeEnvironment
    {
        public string? GetLocalAppDataPath() => localAppData;

        public bool IsStableChromeRunning() => running;
    }

    private sealed class FakeFile(params string?[] responses) : IChromeDiscoveryFile
    {
        private readonly Queue<string?> _responses = new(responses);

        public int ReadCalls { get; private set; }

        public List<string> Paths { get; } = [];

        public string? Read(string path, int maximumCharacters)
        {
            ReadCalls++;
            Paths.Add(path);
            return _responses.Count == 0 ? null : _responses.Dequeue();
        }
    }
}
