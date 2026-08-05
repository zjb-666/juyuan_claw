namespace OpenClawTray.Helpers;

/// <summary>
/// UI gate for platform-owned LLM billing. When locked, Hub hides Config /
/// local Gateway setup surfaces that would let users enter provider keys or
/// bypass the juyuancloud allowlist.
/// </summary>
internal static class ProductBillingGate
{
    public static bool IsLocked => OpenClaw.Shared.ProductPlatformBilling.LockClientSurfaces;
}
