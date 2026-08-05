using OpenClawTray.FunctionalUI.Core;

namespace OpenClawTray.FunctionalUI.Tests;

public sealed class RenderContextTests
{
    [Fact]
    public void UseEffect_WithExplicitEmptyDependencies_RunsExactlyOnceOnFirstMount()
    {
        var ctx = new RenderContext();
        var ranCount = 0;

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, Array.Empty<object>()));
        Assert.Equal(1, ranCount);

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, Array.Empty<object>()));
        Assert.Equal(1, ranCount);
    }

    [Fact]
    public void UseEffect_WithOmittedDependencies_RunsExactlyOnceOnFirstMount()
    {
        var ctx = new RenderContext();
        var ranCount = 0;

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }));
        Assert.Equal(1, ranCount);

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }));
        Assert.Equal(1, ranCount);
    }

    [Fact]
    public void UseEffect_WithChangingDependencies_RunsOnEveryDependencyChange()
    {
        var ctx = new RenderContext();
        var ranCount = 0;

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, new object[] { 1 }));
        Assert.Equal(1, ranCount);

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, new object[] { 2 }));
        Assert.Equal(2, ranCount);

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, new object[] { 2 }));
        Assert.Equal(2, ranCount);
    }

    [Fact]
    public void UseEffect_WithStableDependencies_RunsOnceThenSkips()
    {
        var ctx = new RenderContext();
        var ranCount = 0;

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, new object[] { "x" }));
        Assert.Equal(1, ranCount);

        Render(ctx, () => ctx.UseEffect(() => { ranCount++; }, new object[] { "x" }));
        Assert.Equal(1, ranCount);
    }

    [Fact]
    public void RunEffectCleanups_InvokesRegisteredCleanupOnce()
    {
        var ctx = new RenderContext();
        var cleanupCount = 0;

        Render(ctx, () => ctx.UseEffect(() => () => cleanupCount++, Array.Empty<object>()));

        ctx.RunEffectCleanups();
        ctx.RunEffectCleanups();

        Assert.Equal(1, cleanupCount);
    }

    [Fact]
    public void UseEffect_WithChangingDependencies_RunsPreviousCleanup()
    {
        var ctx = new RenderContext();
        var cleanupCount = 0;

        Render(ctx, () => ctx.UseEffect(() => () => cleanupCount++, new object[] { 1 }));
        Render(ctx, () => ctx.UseEffect(() => () => cleanupCount++, new object[] { 2 }));

        Assert.Equal(1, cleanupCount);
    }

    [Fact]
    public void UseReducer_UpdaterUsesLatestHookValue()
    {
        var ctx = new RenderContext();
        var value = 0;
        Action<Func<int, int>> update = _ => { };

        Render(ctx, () =>
        {
            (value, update) = ctx.UseReducer(0, threadSafe: true);
        });

        update(prev => prev + 1);
        update(prev => prev + 1);

        Render(ctx, () =>
        {
            (value, update) = ctx.UseReducer(0, threadSafe: true);
        });

        Assert.Equal(2, value);
    }

    private static void Render(RenderContext ctx, Action render)
    {
        var effects = new List<Action>();
        ctx.BeginRender(requestRender: () => { }, afterRender: effects.Add);
        render();

        foreach (var effect in effects)
            effect();
    }
}
