using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using OpenClaw.Connection;
using OpenClaw.Shared;
using System;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using WinUIEx;

namespace OpenClawTray.Product;

internal sealed class ProductLoginWindow : WindowEx
{
    private readonly ProductConfig _config;
    private readonly IGatewayConnectionManager _connectionManager;
    private readonly GatewayRegistry _gatewayRegistry;
    private readonly WebView2 _webView = new();
    private bool _provisioning;
    private readonly ProgressRing _loading = new()
    {
        IsActive = true,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
    };
    private readonly TextBlock _error = new()
    {
        Visibility = Visibility.Collapsed,
        TextWrapping = TextWrapping.Wrap,
        HorizontalAlignment = HorizontalAlignment.Center,
        VerticalAlignment = VerticalAlignment.Center,
        MaxWidth = 560,
    };

    public ProductLoginWindow(
        ProductConfig config,
        IGatewayConnectionManager connectionManager,
        GatewayRegistry gatewayRegistry)
    {
        _config = config;
        _connectionManager = connectionManager;
        _gatewayRegistry = gatewayRegistry;
        Title = "聚元灵创登录";
        this.SetWindowSize(960, 720);

        var root = new Grid();
        root.Children.Add(_webView);
        root.Children.Add(_loading);
        root.Children.Add(_error);
        Content = root;
        Closed += OnClosed;
        Activated += OnActivated;
    }

    public event EventHandler? Provisioned;

    private async void OnActivated(object sender, WindowActivatedEventArgs args)
    {
        Activated -= OnActivated;
        await InitializeAsync();
    }

    private async Task InitializeAsync()
    {
        try
        {
            // Keep WebView2 profile under LocalAppData. Writing beside the exe (default
            // when installed on D:) can leave orphaned edge processes and slow/frozen UI.
            var userDataFolder = Path.Combine(
                AppIdentity.ResolveLocalDataDirectory(),
                "WebView2",
                "ProductLogin");
            Directory.CreateDirectory(userDataFolder);
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", userDataFolder);
            await _webView.EnsureCoreWebView2Async();
            var core = _webView.CoreWebView2;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsWebMessageEnabled = true;
            core.NavigationStarting += OnNavigationStarting;
            core.NavigationCompleted += OnNavigationCompleted;
            core.WebMessageReceived += OnWebMessageReceived;
            core.Navigate($"{_config.ProductApiBaseUrl}/?client=windows-hub&desktopLogin=1");
        }
        catch (Exception ex)
        {
            ShowError($"登录页加载失败：{ex.Message}");
        }
    }

    private void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (!IsAllowedProductUri(args.Uri))
        {
            args.Cancel = true;
            ShowError("已阻止跳转到非聚元灵创平台地址。");
        }
    }

    private void OnNavigationCompleted(CoreWebView2 sender, CoreWebView2NavigationCompletedEventArgs args)
    {
        _loading.IsActive = false;
        _loading.Visibility = Visibility.Collapsed;
        if (!args.IsSuccess)
        {
            ShowError("无法连接聚元灵创平台，请检查网络后重试。");
        }
    }

    private async void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
    {
        try
        {
            var source = new Uri(args.Source);
            if (!SameOrigin(source, new Uri(_config.ProductApiBaseUrl)))
            {
                return;
            }

            using var document = JsonDocument.Parse(args.WebMessageAsJson);
            if (!document.RootElement.TryGetProperty("type", out var type) ||
                !string.Equals(type.GetString(), "juyuan.login.completed", StringComparison.Ordinal))
            {
                return;
            }

            if (!document.RootElement.TryGetProperty("accessToken", out var accessTokenElement))
            {
                ShowError("登录响应缺少客户端会话，请重新登录。");
                return;
            }

            var accessToken = accessTokenElement.GetString();
            if (string.IsNullOrWhiteSpace(accessToken))
            {
                ShowError("登录响应无效，请重新登录。");
                return;
            }

            ProductAuthStore.SaveAccessToken(accessToken);

            if (_provisioning)
            {
                return;
            }

            _provisioning = true;
            _error.Visibility = Visibility.Collapsed;
            _loading.Visibility = Visibility.Visible;
            _loading.IsActive = true;
            var bootstrap = await RequestBootstrapAsync(accessToken);
            var matchingGateway = _gatewayRegistry.FindByUrl(bootstrap.GatewayUrl);
            var hasStoredOperatorToken = matchingGateway is not null &&
                DeviceIdentity.HasStoredDeviceTokenForRole(
                    _gatewayRegistry.GetIdentityDirectory(matchingGateway.Id),
                    "operator");
            if (matchingGateway is not null && hasStoredOperatorToken)
            {
                await _connectionManager.SwitchGatewayAsync(matchingGateway.Id);
            }
            else
            {
                if (string.IsNullOrWhiteSpace(bootstrap.SetupCode))
                {
                    throw new InvalidOperationException("此设备尚未配对，平台未返回一次性配对码。");
                }

                var result = await _connectionManager.ApplySetupCodeAsync(bootstrap.SetupCode);
                if (result.Outcome != SetupCodeOutcome.Success)
                {
                    ShowError(result.ErrorMessage ?? "Gateway 自动连接失败，请重试。");
                    return;
                }
            }

            Provisioned?.Invoke(this, EventArgs.Empty);
            Close();
        }
        catch (Exception ex)
        {
            ShowError($"自动连接失败：{ex.Message}");
        }
        finally
        {
            _provisioning = false;
        }
    }

    private async Task<DesktopBootstrap> RequestBootstrapAsync(string accessToken)
    {
        var pairedGatewayUrls = _gatewayRegistry.GetAll()
            .Where(record => DeviceIdentity.HasStoredDeviceTokenForRole(
                _gatewayRegistry.GetIdentityDirectory(record.Id),
                "operator"))
            .Select(record => record.Url)
            .ToArray();
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_config.ProductApiBaseUrl}/api/desktop/bootstrap")
        {
            Content = new StringContent(
                JsonSerializer.Serialize(new { pairedGatewayUrls }),
                Encoding.UTF8,
                "application/json"),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue(
            "Bearer",
            accessToken);
        using var response = await ProductHttpClient.Instance.SendAsync(request);
        var payload = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException("平台暂时无法为此账号分配专属 Gateway。");
        }

        using var document = JsonDocument.Parse(payload);
        var data = document.RootElement.GetProperty("data");
        var gatewayUrl = data.GetProperty("gatewayUrl").GetString();
        var setupCode = data.TryGetProperty("setupCode", out var setupCodeElement)
            ? setupCodeElement.GetString()
            : null;
        return !string.IsNullOrWhiteSpace(gatewayUrl)
            ? new DesktopBootstrap(gatewayUrl, setupCode)
            : throw new InvalidOperationException("平台返回的专属 Gateway 信息无效。");
    }

    private bool IsAllowedProductUri(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var candidate))
        {
            return false;
        }

        return SameOrigin(candidate, new Uri(_config.ProductApiBaseUrl));
    }

    private static bool SameOrigin(Uri left, Uri right) =>
        string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase) &&
        left.Port == right.Port;

    private sealed record DesktopBootstrap(string GatewayUrl, string? SetupCode);

    private void ShowError(string message)
    {
        _loading.IsActive = false;
        _loading.Visibility = Visibility.Collapsed;
        _error.Text = message;
        _error.Visibility = Visibility.Visible;
    }

    private void OnClosed(object sender, WindowEventArgs args)
    {
        if (_webView.CoreWebView2 is { } core)
        {
            core.NavigationStarting -= OnNavigationStarting;
            core.NavigationCompleted -= OnNavigationCompleted;
            core.WebMessageReceived -= OnWebMessageReceived;
            try { core.Navigate("about:blank"); }
            catch { /* closing */ }
        }

        try
        {
            // Drop the control so Edge WebView2 child processes do not linger after "close".
            Content = new Grid();
        }
        catch { /* closing */ }
    }

    private static class ProductHttpClient
    {
        internal static readonly HttpClient Instance = new()
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
    }
}
