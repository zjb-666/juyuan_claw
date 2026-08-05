using OpenClaw.Shared;
using Xunit;

namespace OpenClaw.Shared.Tests;

public class ProductPlatformBillingTests
{
    [Theory]
    [InlineData("qwen3_6_plus")]
    [InlineData("deepseek_v4_pro")]
    [InlineData("glm_5")]
    [InlineData("juyuancloud/qwen3_6_plus")]
    public void IsAllowedModel_True_ForWhitelist(string id)
    {
        Assert.True(ProductPlatformBilling.IsAllowedModel(id));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("gpt-4o")]
    [InlineData("openai/gpt-5")]
    public void IsAllowedModel_False_ForOthers(string? id)
    {
        Assert.False(ProductPlatformBilling.IsAllowedModel(id));
    }

    [Fact]
    public void FilterModelsList_KeepsOnlyWhitelist_AndClearsRequiresAuth()
    {
        var input = new ModelsListInfo
        {
            Models =
            {
                new ModelInfo { Id = "qwen3_6_plus", RequiresAuth = true, IsConfigured = false },
                new ModelInfo { Id = "gpt-4o", IsConfigured = true },
                new ModelInfo { Id = "deepseek_v4_pro", IsConfigured = true },
            }
        };

        var filtered = ProductPlatformBilling.FilterModelsList(input);

        Assert.Equal(2, filtered.Models.Count);
        Assert.All(filtered.Models, m => Assert.False(m.RequiresAuth));
        Assert.Contains(filtered.Models, m => m.Id == "qwen3_6_plus" && m.IsConfigured);
        Assert.Contains(filtered.Models, m => m.Id == "deepseek_v4_pro");
    }

    [Fact]
    public void TryMapUserFacingError_MapsInsufficientPoints()
    {
        var mapped = ProductPlatformBilling.TryMapUserFacingError(
            "vendor rejected",
            ProductPlatformBilling.InsufficientPointsCode);

        Assert.NotNull(mapped);
        Assert.Contains("算力", mapped);
    }

    [Fact]
    public void TryMapUserFacingError_ReturnsNull_ForUnrelated()
    {
        Assert.Null(ProductPlatformBilling.TryMapUserFacingError("connection refused"));
    }

    [Fact]
    public void LockClientSurfaces_DefaultsTrue()
    {
        Assert.True(ProductPlatformBilling.LockClientSurfaces);
    }

    [Fact]
    public void AllowedModelIds_MatchPlatformWhitelist()
    {
        Assert.Equal(
            new[] { "qwen3_6_plus", "deepseek_v4_pro", "glm_5" },
            ProductPlatformBilling.AllowedModelIds);
    }
}
