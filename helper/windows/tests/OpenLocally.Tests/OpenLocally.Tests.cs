using OpenLocally;

namespace OpenLocally.Tests;

public class UriRequestParserTests
{
    private const string Base = "creatorcrate-open://open?v=2&path=C%3A%5CProjects%5CMy%20Project&select=0";

    private static UriParseResult Parse(string uri) => UriRequestParser.Parse(uri);

    private static UriParseResult ParseQuery(string query) => Parse($"creatorcrate-open://open?{query}");

    // --- Valid ---

    [Fact]
    public void Parse_FolderUri_ReturnsSuccessWithSelectFalse()
    {
        UriParseResult result = Parse(Base);

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"C:\Projects\My Project", result.Request.Path);
        Assert.False(result.Request.Select);
        Assert.Null(result.Error);
    }

    [Fact]
    public void Parse_FileUri_ReturnsSuccessWithSelectTrue()
    {
        UriParseResult result = Parse("creatorcrate-open://open?v=2&path=C%3A%5CProjects%5CMy%20Project%5Chero.png&select=1");

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"C:\Projects\My Project\hero.png", result.Request.Path);
        Assert.True(result.Request.Select);
    }

    [Fact]
    public void Parse_EncodedUnicode_ReturnsDecodedPath()
    {
        UriParseResult result = Parse("creatorcrate-open://open?v=2&path=D%3A%5CProyectos%5C%E2%82%AC%20Studios&select=0");

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"D:\Proyectos\€ Studios", result.Request.Path);
    }

    [Fact]
    public void Parse_EncodedSlashInPath_ReturnsDecodedPath()
    {
        UriParseResult result = Parse("creatorcrate-open://open?v=2&path=C%3A%2FProjects%2Fhero.png&select=0");

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"C:/Projects/hero.png", result.Request.Path);
    }

    [Fact]
    public void Parse_UnencodedColonAndBackslashes_AreAcceptedVerbatim()
    {
        UriParseResult result = Parse(@"creatorcrate-open://open?v=2&path=C:\Projects\My Project&select=0");

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"C:\Projects\My Project", result.Request.Path);
    }

    [Fact]
    public void Parse_BrowserNormalizedRootPath_IsAccepted()
    {
        // Browsers rewrite "scheme://open?query" to "scheme://open/?query",
        // adding a root path after the authority; the helper must accept it.
        UriParseResult result = Parse("creatorcrate-open://open/?v=2&path=C%3A%5CProjects%5CMy%20Project&select=0");

        Assert.True(result.Success);
        Assert.NotNull(result.Request);
        Assert.Equal(@"C:\Projects\My Project", result.Request.Path);
        Assert.False(result.Request.Select);
    }

    // --- Invalid: scheme / host ---

    [Theory]
    [InlineData("http://open?v=2&path=C%3A%5Cfoo&select=0")]
    [InlineData("creatorcrate://open?v=2&path=C%3A%5Cfoo&select=0")]
    [InlineData("creatorcrate-open:open?v=2&path=C%3A%5Cfoo&select=0")]
    public void Parse_WrongScheme_ReturnsFailure(string uri)
    {
        UriParseResult result = Parse(uri);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("creatorcrate-open://launch?v=2&path=C%3A%5Cfoo&select=0")]
    [InlineData("creatorcrate-open://open/extra?v=2&path=C%3A%5Cfoo&select=0")]
    public void Parse_WrongHost_ReturnsFailure(string uri)
    {
        UriParseResult result = Parse(uri);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    // --- Invalid: missing / empty / duplicate / unknown parameters ---

    [Theory]
    [InlineData("path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo")]
    public void Parse_MissingField_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("v=&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2&path=&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo&select=")]
    public void Parse_EmptyRequiredValue_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("v=2&v=2&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo&select=0&select=0")]
    public void Parse_DuplicateKey_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("v=2&path=C%3A%5Cfoo&select=0&extra=1")]
    [InlineData("v=2&mapping=projects&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo&select=0&path2=other")]
    public void Parse_UnknownKey_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    // --- Invalid: malformed encoding ---

    [Theory]
    [InlineData("v=2&path=C%3A%5Cfo%2o&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo%&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo%2&select=0")]
    [InlineData("v=2&path=C%3A%5Cfoo%GG&select=0")]
    public void Parse_MalformedEncoding_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Fact]
    public void Parse_InvalidUtf8Sequence_ReturnsFailure()
    {
        UriParseResult result = ParseQuery("v=2&path=C%3A%5Cfoo%2F%FF&select=0");

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    // --- Invalid: version / select ---

    [Theory]
    [InlineData("v=1&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=3&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=02&path=C%3A%5Cfoo&select=0")]
    [InlineData("v=2.0&path=C%3A%5Cfoo&select=0")]
    public void Parse_InvalidVersion_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    [Theory]
    [InlineData("v=2&path=C%3A%5Cfoo&select=2")]
    [InlineData("v=2&path=C%3A%5Cfoo&select=true")]
    [InlineData("v=2&path=C%3A%5Cfoo&select=yes")]
    public void Parse_InvalidSelect_ReturnsFailure(string query)
    {
        UriParseResult result = ParseQuery(query);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }

    // --- Invalid: structural ---

    [Theory]
    [InlineData("")]
    [InlineData("not a uri")]
    [InlineData("creatorcrate-open://open")]
    [InlineData("creatorcrate-open://open?v=2&path=C%3A%5Cfoo&select=0#fragment")]
    [InlineData("creatorcrate-open://open?v=2&path=C%3A%5Cfoo&select=0&")]
    [InlineData("creatorcrate-open://open?v=2&path=C%3A%5Cfoo&select=0&&select=0")]
    public void Parse_MalformedUri_ReturnsFailure(string uri)
    {
        UriParseResult result = Parse(uri);

        Assert.False(result.Success);
        Assert.Null(result.Request);
        Assert.NotNull(result.Error);
    }
}

public class PathResolverTests
{
    // Fixed drive letter keeps the tests independent of the machine's drives
    // while still exercising drive-letter semantics; no real folder is touched.
    private const string Root = @"D:\example";

    private static PathValidationResult Validate(string? path) =>
        PathResolver.Validate(path);

    private static void AssertFailure(PathValidationResult result)
    {
        Assert.False(result.Success);
        Assert.Null(result.FullPath);
        Assert.NotNull(result.Error);
    }

    // --- Valid ---

    [Fact]
    public void Validate_AbsoluteFolderPath_ReturnsNormalizedPath()
    {
        PathValidationResult result = Validate(Root);

        Assert.True(result.Success);
        Assert.Null(result.Error);
        Assert.Equal(Root, result.FullPath);
    }

    [Fact]
    public void Validate_AbsoluteFilePath_ReturnsNormalizedPath()
    {
        PathValidationResult result = Validate(@"D:\example\000001-demo\assets\hero.png");

        Assert.True(result.Success);
        Assert.Equal(@"D:\example\000001-demo\assets\hero.png", result.FullPath);
    }

    [Fact]
    public void Validate_ForwardSlashPath_IsAcceptedAndNormalized()
    {
        PathValidationResult result = Validate("D:/example/000001-demo/hero.png");

        Assert.True(result.Success);
        Assert.Equal(@"D:\example\000001-demo\hero.png", result.FullPath);
        Assert.DoesNotContain('/', result.FullPath!);
    }

    [Fact]
    public void Validate_PathWithSpaces_ReturnsNormalizedPath()
    {
        PathValidationResult result = Validate(@"D:\example\my hero asset.png");

        Assert.True(result.Success);
        Assert.Equal(@"D:\example\my hero asset.png", result.FullPath);
    }

    [Fact]
    public void Validate_UnicodePath_ReturnsNormalizedPath()
    {
        PathValidationResult result = Validate(@"D:\Proyectos\€ Studios");

        Assert.True(result.Success);
        Assert.Equal(@"D:\Proyectos\€ Studios", result.FullPath);
    }

    [Fact]
    public void Validate_LowercaseDriveLetter_IsAccepted()
    {
        PathValidationResult result = Validate(@"n:\ai project files\000001-demo");

        Assert.True(result.Success);
        Assert.NotNull(result.FullPath);
    }

    [Fact]
    public void Validate_TrailingSlash_ReturnsNormalizedPathWithoutDoubleSeparator()
    {
        PathValidationResult result = Validate(@"D:\example\000001-demo\");

        Assert.True(result.Success);
        Assert.Equal(@"D:\example\000001-demo", result.FullPath);
    }

    // --- Invalid ---

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public void Validate_EmptyPath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Fact]
    public void Validate_NullPath_ReturnsFailure()
    {
        AssertFailure(Validate(null));
    }

    [Theory]
    [InlineData("/foo")]
    [InlineData("\\foo")]
    [InlineData("000001-demo")]
    [InlineData("foo/bar")]
    public void Validate_RelativePath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"C:foo")]
    [InlineData(@"c:foo")]
    public void Validate_DriveRelativePath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"C:")]
    [InlineData(@"C:\")]
    [InlineData(@"C:\\")]
    [InlineData(@"C:\\.\")]
    public void Validate_BareDrivePath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"\\server\share")]
    [InlineData("//server/share")]
    [InlineData(@"\\server")]
    public void Validate_UncPath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"\\?\C:\foo")]
    [InlineData(@"\\.\C:\foo")]
    public void Validate_DevicePath_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"C:\..")]
    [InlineData(@"C:\folder\..\other")]
    [InlineData(@"C:\folder\..")]
    [InlineData(@"C:\a\..\..")]
    [InlineData(@"C:\..\folder")]
    [InlineData(@"C:\.\folder")]
    [InlineData(@"C:\folder\.\other")]
    public void Validate_DotOrTraversalSegment_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Theory]
    [InlineData(@"C:\CON")]
    [InlineData(@"C:\PRN")]
    [InlineData(@"C:\AUX")]
    [InlineData(@"C:\NUL")]
    [InlineData(@"C:\COM1")]
    [InlineData(@"C:\COM9")]
    [InlineData(@"C:\LPT1")]
    [InlineData(@"C:\LPT9")]
    [InlineData(@"C:\con")]
    [InlineData(@"C:\folder\CON")]
    [InlineData(@"C:\CON.txt")]
    [InlineData(@"C:\folder\NUL.log")]
    public void Validate_ReservedDeviceName_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }

    [Fact]
    public void Validate_ControlCharacter_ReturnsFailure()
    {
        AssertFailure(Validate("C:\\foo\tbar"));
        AssertFailure(Validate("C:\nfoo"));
    }

    [Fact]
    public void Validate_NullCharacter_ReturnsFailure()
    {
        AssertFailure(Validate("C:\0foo"));
    }

    [Theory]
    [InlineData(@"C:\file.txt:stream")]
    [InlineData(@"C:\folder\file.txt:stream")]
    [InlineData(@"C:\folder:name\file.txt")]
    public void Validate_AlternateDataStreamSyntax_ReturnsFailure(string path)
    {
        AssertFailure(Validate(path));
    }
}
