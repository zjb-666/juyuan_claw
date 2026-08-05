namespace OpenClaw.Shared;

/// <summary>
/// Platform-owned LLM billing lock for 聚元灵创 / juyuancloud.
/// User Gateways must call only the platform chat/completions exit; the Windows
/// Hub must not expose custom providers, API keys, or off-whitelist models.
/// Contract: product/docs/gateway-llm-billing-integration.md
/// </summary>
public static class ProductPlatformBilling
{
    /// <summary>
    /// Product builds always lock client surfaces. Tests may temporarily set
    /// false via <see cref="SetLockClientSurfacesForTests"/> only.
    /// </summary>
    public static bool LockClientSurfaces { get; private set; } = true;

    public const string DefaultModelId = "qwen3_6_plus";

    public const string InsufficientPointsCode = "INSUFFICIENT_POINTS";
    public const string ModelNotAllowedCode = "model_not_allowed";
    public const string UnauthorizedCode = "unauthorized";

    /// <summary>Canonical allowlist model ids from the platform billing exit.</summary>
    public static readonly IReadOnlyList<string> AllowedModelIds = new[]
    {
        "qwen3_6_plus",
        "deepseek_v4_pro",
        "glm_5",
    };

    private static readonly HashSet<string> AllowedModelIdSet =
        new(AllowedModelIds, StringComparer.OrdinalIgnoreCase);

    public static void SetLockClientSurfacesForTests(bool locked) =>
        LockClientSurfaces = locked;

    public static bool IsAllowedModel(string? modelId)
    {
        if (string.IsNullOrWhiteSpace(modelId))
            return false;
        // Accept bare ids and provider-prefixed forms (juyuancloud/qwen3_6_plus).
        var id = modelId.Trim();
        if (AllowedModelIdSet.Contains(id))
            return true;
        var slash = id.LastIndexOf('/');
        if (slash >= 0 && slash < id.Length - 1)
            return AllowedModelIdSet.Contains(id[(slash + 1)..]);
        return false;
    }

    public static ModelsListInfo FilterModelsList(ModelsListInfo? info)
    {
        if (info is null)
            return new ModelsListInfo();

        var filtered = new List<ModelInfo>();
        foreach (var model in info.Models)
        {
            if (model is null || !IsAllowedModel(model.Id))
                continue;
            // Platform owns auth; never prompt the client to enter a provider key.
            model.RequiresAuth = false;
            if (!model.IsConfigured)
            {
                model.IsConfigured = true;
                model.HasConfiguredFlag = true;
            }
            filtered.Add(model);
        }

        return new ModelsListInfo { Models = filtered };
    }

    public static string[] FilterModelIds(IEnumerable<string>? ids)
    {
        if (ids is null)
            return Array.Empty<string>();

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<string>();
        foreach (var id in ids)
        {
            if (!IsAllowedModel(id) || !seen.Add(id.Trim()))
                continue;
            list.Add(id.Trim());
        }
        return list.ToArray();
    }

    /// <summary>
    /// Maps platform billing / allowlist failures to a user-facing Chinese message.
    /// Returns null when the text is unrelated so callers keep the original error.
    /// </summary>
    public static string? TryMapUserFacingError(string? messageOrCode, params string?[] extraCodes)
    {
        if (ContainsCode(messageOrCode, InsufficientPointsCode) ||
            CodesContain(extraCodes, InsufficientPointsCode) ||
            ContainsInsensitive(messageOrCode, "insufficient points") ||
            ContainsInsensitive(messageOrCode, "算力不足"))
        {
            return "算力余额不足，请前往聚元云平台充值后再试。";
        }

        if (ContainsCode(messageOrCode, ModelNotAllowedCode) ||
            CodesContain(extraCodes, ModelNotAllowedCode))
        {
            return "当前模型不在平台白名单内，请改用可用模型。";
        }

        if (ContainsInsensitive(messageOrCode, "agent run failed before producing a reply"))
        {
            return "助手本次未能生成回复。请切换到白名单模型（如 qwen3_6_plus），或联系运维检查 Gateway 模型与算力出口。";
        }

        if (ContainsCode(messageOrCode, UnauthorizedCode) ||
            CodesContain(extraCodes, UnauthorizedCode))
        {
            // Only rewrite when the payload looks like the LLM exit, not generic gateway auth.
            if (ContainsInsensitive(messageOrCode, "sk-jyc") ||
                ContainsInsensitive(messageOrCode, "llm") ||
                ContainsInsensitive(messageOrCode, "api key") ||
                ContainsInsensitive(messageOrCode, "apikey"))
            {
                return "平台模型鉴权失败，请联系运维检查该用户 Gateway 的计费出口配置。";
            }
        }

        return null;
    }

    public static string MapUserFacingErrorOrOriginal(string? messageOrCode, params string?[] extraCodes) =>
        TryMapUserFacingError(messageOrCode, extraCodes) ?? (messageOrCode ?? "request failed");

    private static bool CodesContain(string?[]? codes, string expected)
    {
        if (codes is null) return false;
        foreach (var code in codes)
        {
            if (ContainsCode(code, expected))
                return true;
        }
        return false;
    }

    private static bool ContainsCode(string? text, string code) =>
        !string.IsNullOrWhiteSpace(text) &&
        text.Contains(code, StringComparison.OrdinalIgnoreCase);

    private static bool ContainsInsensitive(string? text, string fragment) =>
        !string.IsNullOrWhiteSpace(text) &&
        text.Contains(fragment, StringComparison.OrdinalIgnoreCase);
}
