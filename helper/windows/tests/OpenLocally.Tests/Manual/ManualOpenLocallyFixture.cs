using OpenLocally;

namespace OpenLocally.Tests.Manual;

internal sealed record ManualOpenLocallyRequest(string FixturePath, string Uri)
{
    internal const string FileName = "harmless.txt";

    internal static ManualOpenLocallyRequest Create(string root)
    {
        string directory = Path.Combine(root, "open-locally");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, FileName);
        File.WriteAllText(path, "CreatorCrate manual harness");

        return new ManualOpenLocallyRequest(
            path,
            $"creatorcrate-open://open?v=2&path={System.Uri.EscapeDataString(path)}&select=1");
    }
}
