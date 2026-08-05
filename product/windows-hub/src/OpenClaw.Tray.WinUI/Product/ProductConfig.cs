using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace OpenClawTray.Product;

internal sealed record ProductConfig(string ProductApiBaseUrl)
{
    private const string ConfigFileName = "product-config.json";

    public static ProductConfig Load(string? baseDirectory = null)
    {
        var overrideUrl = Environment.GetEnvironmentVariable("JUYUAN_PRODUCT_API_URL");
        if (!string.IsNullOrWhiteSpace(overrideUrl))
        {
            return new ProductConfig(NormalizeProductApiUrl(overrideUrl));
        }

        var path = Path.Combine(baseDirectory ?? AppContext.BaseDirectory, ConfigFileName);
        if (!File.Exists(path))
        {
            throw new InvalidOperationException($"Missing {ConfigFileName}.");
        }

        using var document = JsonDocument.Parse(File.ReadAllText(path));
        var configuredUrl = document.RootElement.TryGetProperty("productApiBaseUrl", out var value)
            ? value.GetString()
            : null;
        return new ProductConfig(NormalizeProductApiUrl(configuredUrl));
    }

    private static string NormalizeProductApiUrl(string? value)
    {
        var trimmed = value?.Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            throw new InvalidOperationException(
                "Product API URL is not configured. Set it at build time before distributing the installer.");
        }

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) ||
            string.IsNullOrWhiteSpace(uri.Host))
        {
            throw new InvalidOperationException("Product API URL must be an absolute URL with a host.");
        }

        var isHttp = string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase);
        var isHttps = string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase);
        if (!isHttp && !isHttps)
        {
            throw new InvalidOperationException("Product API URL must use http or https.");
        }

        // Dev packages may target LAN HTTP for internal testing. Release packages stay public HTTPS only.
        if (AppIdentity.IsDev)
        {
            if (!IsAllowedDevHost(uri))
            {
                throw new InvalidOperationException(
                    "Dev Product API URL must use localhost, a LAN/private host, or HTTPS.");
            }

            return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        }

        if (!isHttps)
        {
            throw new InvalidOperationException("Product API URL must be a public HTTPS URL.");
        }

        if (uri.IsLoopback || IsPrivateOrLocalHost(uri.Host))
        {
            throw new InvalidOperationException("Product API URL must not use a loopback or private LAN address.");
        }

        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }

    private static bool IsAllowedDevHost(Uri uri)
    {
        if (string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        // HTTP is limited to local/LAN targets so a Dev package cannot silently ship a public cleartext endpoint.
        return uri.IsLoopback || IsPrivateOrLocalHost(uri.Host);
    }

    private static bool IsPrivateOrLocalHost(string host)
    {
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        if (!IPAddress.TryParse(host, out var address))
        {
            // Unresolved hostnames are treated as non-private; Dev HTTPS still allowed above.
            return false;
        }

        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();
            return bytes[0] == 10
                || (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
                || (bytes[0] == 192 && bytes[1] == 168)
                || (bytes[0] == 169 && bytes[1] == 254);
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            return address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6UniqueLocal;
        }

        return false;
    }
}
