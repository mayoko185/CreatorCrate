using System.Runtime.InteropServices;
namespace OpenLocally;
public interface IOriginTrustPrompt { bool ConfirmTrust(SocialOrigin origin); }
public sealed class NativeOriginTrustPrompt : IOriginTrustPrompt
{
    public bool ConfirmTrust(SocialOrigin origin) =>
        MessageBoxW(IntPtr.Zero, origin.Identity, "Trust CreatorCrate server?", 0x00000004 | 0x00000020) == 6;
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(IntPtr hWnd, string text, string caption, uint type);
}
