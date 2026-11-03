using System.Security.Claims;
using Ackerman.PaymentBoard.Models;
using Microsoft.AspNetCore.Authentication;

namespace Ackerman.PaymentBoard.Services;

public sealed class AccountStateMiddleware
{
    private readonly RequestDelegate _next;

    public AccountStateMiddleware(RequestDelegate next) => _next = next;

    public async Task Invoke(HttpContext context, IUserStore users)
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            var isApi = context.Request.Path.StartsWithSegments("/api");
            var user = users.FindByUsername(context.User.Identity.Name ?? "");
            if (user is null || !user.IsActive)
            {
                await context.SignOutAsync();
                if (isApi) context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                else context.Response.Redirect("/account/login");
                return;
            }

            var cookieRole = context.User.FindFirstValue(ClaimTypes.Role) ?? "";
            if (!string.Equals(cookieRole, user.Role, StringComparison.Ordinal))
            {
                await context.SignOutAsync();
                if (isApi) context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                else context.Response.Redirect("/account/login");
                return;
            }

            var path = context.Request.Path.Value?.ToLowerInvariant() ?? "";
            var allowedDuringPasswordChange = path.StartsWith("/account/change-password") ||
                                              path.StartsWith("/account/logout") ||
                                              path.StartsWith("/assets/") ||
                                              path.StartsWith("/css/");
            if (user.MustChangePassword && !allowedDuringPasswordChange)
            {
                if (isApi) context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                else context.Response.Redirect("/account/change-password");
                return;
            }
        }

        await _next(context);
    }
}
