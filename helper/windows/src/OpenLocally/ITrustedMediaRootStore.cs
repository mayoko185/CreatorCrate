namespace OpenLocally;

public interface ITrustedMediaRootStore
{
    bool IsTrusted(SocialOrigin origin, string normalizedRoot);
    void Trust(SocialOrigin origin, string normalizedRoot);
}

public interface ITrustedMediaRootPrompt
{
    bool ConfirmTrust(SocialOrigin origin, string normalizedRoot);
}
