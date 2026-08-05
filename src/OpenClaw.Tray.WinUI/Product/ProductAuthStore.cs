using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;

namespace OpenClawTray.Product;

/// <summary>
/// Persists the product BFF session JWT after platform login so Hub can call
/// authenticated APIs such as compute-balance without re-opening the login WebView.
/// </summary>
internal static class ProductAuthStore
{
    private const string FileName = "product-session.dpapi";

    public static void SaveAccessToken(string accessToken)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new ArgumentException("Access token is required.", nameof(accessToken));

        var path = ResolvePath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var plain = Encoding.UTF8.GetBytes(accessToken.Trim());
        try
        {
            var protectedBytes = ProtectedData.Protect(plain, optionalEntropy: null, scope: DataProtectionScope.CurrentUser);
            File.WriteAllBytes(path, protectedBytes);
        }
        catch (PlatformNotSupportedException)
        {
            // Non-Windows or missing DPAPI: fall back to restrictive ACL file is not
            // available here; store UTF-8 with a clear local-only warning name.
            File.WriteAllBytes(path, plain);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plain);
        }
    }

    public static string? TryLoadAccessToken()
    {
        var path = ResolvePath();
        if (!File.Exists(path))
            return null;

        try
        {
            var bytes = File.ReadAllBytes(path);
            if (bytes.Length == 0)
                return null;

            byte[] plain;
            try
            {
                plain = ProtectedData.Unprotect(bytes, optionalEntropy: null, scope: DataProtectionScope.CurrentUser);
            }
            catch (CryptographicException)
            {
                plain = bytes;
            }
            catch (PlatformNotSupportedException)
            {
                plain = bytes;
            }

            var token = Encoding.UTF8.GetString(plain).Trim();
            CryptographicOperations.ZeroMemory(plain);
            return string.IsNullOrWhiteSpace(token) ? null : token;
        }
        catch
        {
            return null;
        }
    }

    public static void Clear()
    {
        var path = ResolvePath();
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // Best-effort logout cleanup.
        }
    }

    private static string ResolvePath() =>
        Path.Combine(AppIdentity.ResolveLocalDataDirectory(), FileName);
}
