using System.Runtime.InteropServices;

namespace OpenLocally;

public sealed class NativeTrustedMediaRootPrompt : ITrustedMediaRootPrompt
{
    public bool ConfirmTrust(SocialOrigin origin, string normalizedRoot)
    {
        string text = $"Allow CreatorCrate at {origin.Identity} to use local media under this project root?\n\n{normalizedRoot}";
        return MessageBoxW(IntPtr.Zero, text, "CreatorCrate", 0x00000004 | 0x00000020) == 6;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
}
