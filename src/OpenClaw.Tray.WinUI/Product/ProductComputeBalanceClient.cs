using System;
using System.Globalization;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace OpenClawTray.Product;

internal sealed record ProductComputeBalance(
    double Balance,
    double LedgerSum,
    string Unit,
    string Currency,
    string? UserUuid);

/// <summary>
/// Fetches RH compute balance from the product BFF (which talks to the platform
/// billing exit). The Windows Hub never holds <c>sk-jyc-…</c>.
/// </summary>
internal static class ProductComputeBalanceClient
{
    private static readonly HttpClient Http = new()
    {
        Timeout = TimeSpan.FromSeconds(15),
    };

    public static async Task<ProductComputeBalance?> TryFetchAsync(
        ProductConfig config,
        string accessToken,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            return null;

        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            $"{config.ProductApiBaseUrl}/api/desktop/compute-balance");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken.Trim());
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        using var response = await Http.SendAsync(request, cancellationToken).ConfigureAwait(false);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
            return null;

        using var document = JsonDocument.Parse(payload);
        if (!document.RootElement.TryGetProperty("data", out var data))
            return null;

        if (!TryReadDouble(data, "balance", out var balance))
            return null;

        var ledger = balance;
        if (TryReadDouble(data, "ledgerSum", out var ledgerSum) ||
            TryReadDouble(data, "ledger_sum", out ledgerSum))
        {
            ledger = ledgerSum;
        }

        var unit = ReadString(data, "unit") ?? "RH";
        var currency = ReadString(data, "currency") ?? "compute";
        var userUuid = ReadString(data, "userUuid") ?? ReadString(data, "user_uuid");
        return new ProductComputeBalance(balance, ledger, unit, currency, userUuid);
    }

    public static string FormatDisplay(ProductComputeBalance balance)
    {
        // Always one decimal (e.g. 5844.8). Do not round large balances to integers.
        var text = balance.Balance.ToString("0.0", CultureInfo.InvariantCulture);
        var unit = string.IsNullOrWhiteSpace(balance.Unit) ? "RH" : balance.Unit.Trim();
        return $"算力 {text} {unit}";
    }

    private static bool TryReadDouble(JsonElement data, string name, out double value)
    {
        value = 0;
        if (!data.TryGetProperty(name, out var prop))
            return false;
        if (prop.ValueKind == JsonValueKind.Number && prop.TryGetDouble(out value))
            return true;
        if (prop.ValueKind == JsonValueKind.String &&
            double.TryParse(prop.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out value))
            return true;
        return false;
    }

    private static string? ReadString(JsonElement data, string name) =>
        data.TryGetProperty(name, out var prop) && prop.ValueKind == JsonValueKind.String
            ? prop.GetString()
            : null;
}
