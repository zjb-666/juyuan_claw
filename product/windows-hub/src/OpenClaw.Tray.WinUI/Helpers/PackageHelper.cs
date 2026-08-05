using System;

namespace OpenClawTray.Helpers;

/// <summary>
/// Detects whether the app is running as an MSIX-packaged app or unpackaged.
/// </summary>
internal static class PackageHelper
{
    private static bool? _isPackaged;

    /// <summary>
    /// Returns true if the app is running with package identity (MSIX).
    /// </summary>
    public static bool IsPackaged
    {
        get
        {
            _isPackaged ??= DetectPackaged();
            return _isPackaged.Value;
        }
    }

    private static bool DetectPackaged()
    {
        try
        {
            // Package.Current throws if not running in a packaged context
            var package = global::Windows.ApplicationModel.Package.Current;
            return package != null;
        }
        catch
        {
            return false;
        }
    }
}
