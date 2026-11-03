using Ackerman.PaymentBoard.Models;

namespace Ackerman.PaymentBoard.Services;

public sealed class AuditService
{
    private readonly IAuditStore _store;
    private readonly IHttpContextAccessor _http;

    public AuditService(IAuditStore store, IHttpContextAccessor http)
    {
        _store = store;
        _http = http;
    }

    public void Write(string action, string targetType = "", string targetId = "", string details = "", string? username = null)
    {
        var context = _http.HttpContext;
        _store.Add(new AuditEntry
        {
            Username = username ?? context?.User?.Identity?.Name ?? "system",
            Action = action,
            TargetType = targetType,
            TargetId = targetId,
            Details = details,
            IpAddress = context?.Connection.RemoteIpAddress?.ToString() ?? ""
        });
    }
}
