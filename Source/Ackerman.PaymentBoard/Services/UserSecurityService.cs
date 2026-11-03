using Ackerman.PaymentBoard.Models;
using Microsoft.AspNetCore.Identity;

namespace Ackerman.PaymentBoard.Services;

public sealed class UserSecurityService
{
    private readonly IUserStore _users;
    private readonly PasswordHasher<AppUser> _hasher = new();
    private readonly IConfiguration _configuration;

    public UserSecurityService(IUserStore users, IConfiguration configuration)
    {
        _users = users;
        _configuration = configuration;
    }

    public PasswordVerificationResult Verify(AppUser user, string password)
        => _hasher.VerifyHashedPassword(user, user.PasswordHash, password);

    public void SetPassword(AppUser user, string password)
        => user.PasswordHash = _hasher.HashPassword(user, password);

    public bool IsLockedOut(AppUser user)
        => user.LockoutEndUtc.HasValue && user.LockoutEndUtc.Value > DateTime.UtcNow;

    public void RecordFailure(AppUser user)
    {
        var max = Math.Max(3, _configuration.GetValue<int?>("Security:MaxFailedLogins") ?? 5);
        var minutes = Math.Max(1, _configuration.GetValue<int?>("Security:LockoutMinutes") ?? 15);
        user.FailedLoginCount++;
        if (user.FailedLoginCount >= max)
        {
            user.LockoutEndUtc = DateTime.UtcNow.AddMinutes(minutes);
            user.FailedLoginCount = 0;
        }
        _users.Upsert(user);
    }

    public void RecordSuccess(AppUser user)
    {
        user.FailedLoginCount = 0;
        user.LockoutEndUtc = null;
        user.LastLoginUtc = DateTime.UtcNow;
        _users.Upsert(user);
    }
}
