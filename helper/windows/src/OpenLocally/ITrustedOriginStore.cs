namespace OpenLocally;
public interface ITrustedOriginStore { bool IsTrusted(SocialOrigin origin); void Trust(SocialOrigin origin); }
