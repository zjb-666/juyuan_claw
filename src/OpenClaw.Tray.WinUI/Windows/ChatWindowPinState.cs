namespace OpenClawTray.Windows;

/// <summary>
/// Process-wide flag used by <see cref="ChatWindow.OnWindowActivated"/> to
/// skip the auto-hide behavior. Toggled by the Chat explorations panel so the
/// tray chat popup stays visible while the user previews toggles.
/// </summary>
public static class ChatWindowPinState
{
    public static bool IsPinned { get; set; }
}
