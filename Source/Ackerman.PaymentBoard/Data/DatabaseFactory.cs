using LiteDB;

namespace Ackerman.PaymentBoard.Data;

public sealed class DatabaseFactory : IDisposable
{
    public ILiteDatabase Database { get; }

    public DatabaseFactory(IWebHostEnvironment env, IConfiguration configuration)
    {
        var configuredPath = configuration["Database:Path"] ?? "App_Data/ackerman-payment-board.db";
        var fullPath = Path.IsPathRooted(configuredPath)
            ? configuredPath
            : Path.Combine(env.ContentRootPath, configuredPath.Replace('/', Path.DirectorySeparatorChar));

        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);

        // IIS production uses a single worker process and keeps one LiteDatabase instance
        // for the lifetime of the application. Direct mode avoids LiteDB's Global\ named
        // mutex, which can be denied to low-privilege IIS application-pool identities.
        var configuredConnection = configuration["Database:Connection"] ?? "Direct";
        var connection = Enum.TryParse<ConnectionType>(configuredConnection, ignoreCase: true, out var parsed)
            ? parsed
            : ConnectionType.Direct;

        Database = new LiteDatabase(new ConnectionString
        {
            Filename = fullPath,
            Connection = connection
        });

        // LiteDB stores dates in UTC but by default hands them back converted to the
        // server's local time. Every *Utc field in this app is compared with
        // DateTime.UtcNow (for example the failed-login lockout), so read dates back
        // as UTC. Views already call ToLocalTime() for display.
        Database.UtcDate = true;
    }

    public void Dispose() => Database.Dispose();
}
